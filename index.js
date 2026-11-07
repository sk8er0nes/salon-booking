require('dotenv').config()
const express = require('express');
const cors = require("cors");
const { ObjectId } = require('mongodb');
const bcrypt = require('bcrypt')
const { connect } = require('./db');
const { generateSearchParams, generateAppointment } = require('./openai');
//const { generateSearchParams,generateRecipe } = require('./gemini');

const mongoUri = process.env.MONGO_URI;
const dbname = "salon_booking";
const jwt = require('jsonwebtoken');

const generateAccessToken = (id, email) => {
    return jwt.sign({
        'user_id': id,
        'email': email
    }, process.env.TOKEN_SECRET, {
        expiresIn: "1h"
    });
}

const verifyToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.sendStatus(403);
    jwt.verify(token, process.env.TOKEN_SECRET, (err, user) => {
        if (err) return res.sendStatus(403);
        req.user = user;
        next();
    });
};

const app = express();
app.use(express.json())
app.use(cors());

async function main() {
    try {
        const db = await connect(mongoUri, dbname);
        console.log('Connected to MongoDB');

        // Add your route code here
        app.get("/", function (req, res) {
            res.json({
                message: "Hello World!"
            });
        });

        app.get('/appointments', async (req, res) => {
            try {
                const { client, stylist, services, date } = req.query;
                //const { client } = req.query;
                let query = {};

                if (client) {
                    query['client.name'] = { $regex: client, $options: 'i' };
                }

                if (stylist) {
                    query['stylist.name'] = { $regex: stylist, $options: 'i' };
                }

                if (services) {
                    query['services.name'] = { $all: services.split(',').map(i => new RegExp(i, 'i')) };
                }

                if (date) {
                    const startOfDay = new Date(`${date}T00:00:00.000Z`);
                    const endOfDay = new Date(`${date}T23:59:59.999Z`);
                    query.dateTime = { $gte: startOfDay, $lte: endOfDay };
                }

                const appointments = await db.collection('appointments').find(query).project({
                    'client.name': 1,
                    'stylist.name': 1,
                    'services.name': 1,
                    'dateTime': 1,
                    'totalDuration': 1,
                    'totalPrice': 1,
                    'status': 1,
                    _id: 0
                }).toArray();

                res.json({ appointments });
            } catch (error) {
                console.error('Error searching apppointments:', error);
                res.status(500).json({ error: 'Internal server error' });
            }
        });

        app.post('/appointments', async (req, res) => {
            try {
                const { phone, stylist, services, dateTime } = req.body ?? {};

                // 1. Validate the request.
                if (
                    typeof phone !== 'string' || !phone.trim() ||
                    typeof stylist !== 'string' || !stylist.trim() ||
                    !Array.isArray(services) || services.length === 0 ||
                    services.some(service =>
                        typeof service !== 'string' || !service.trim()
                    ) ||
                    typeof dateTime !== 'string'
                ) {
                    return res.status(400).json({
                        error:
                            'Provide phone, stylist, a non-empty array of service names, and dateTime.'
                    });
                }

                // Require an explicit timezone to avoid server timezone ambiguity.
                if (!/T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(dateTime)) {
                    return res.status(400).json({
                        error: 'dateTime must include a timezone, e.g. 2026-11-10T10:00:00+08:00.'
                    });
                }

                const appointmentDate = new Date(dateTime);

                if (Number.isNaN(appointmentDate.getTime())) {
                    return res.status(400).json({
                        error: 'Invalid appointment date and time.'
                    });
                }

                if (appointmentDate <= new Date()) {
                    return res.status(400).json({
                        error: 'Appointment date and time must be in the future.'
                    });
                }

                const serviceNames = services.map(name => name.trim());

                if (new Set(serviceNames).size !== serviceNames.length) {
                    return res.status(400).json({
                        error: 'Do not include duplicate services.'
                    });
                }

                // 2. Find the client by their stored phone number.
                const client = await db.collection('users').findOne(
                    { phone: phone.trim() },
                    { projection: { _id: 1, name: 1 } }
                );

                if (!client) {
                    return res.status(404).json({
                        error: 'No user found with that phone number.'
                    });
                }

                // 3. Find the stylist using their exact name.
                const stylistMatches = await db
                    .collection('stylists')
                    .find({ name: stylist.trim() })
                    .limit(2)
                    .toArray();

                if (stylistMatches.length === 0) {
                    return res.status(404).json({
                        error: 'Stylist not found.'
                    });
                }

                if (stylistMatches.length > 1) {
                    return res.status(409).json({
                        error: 'Multiple stylists have this name. Use a unique stylist ID instead.'
                    });
                }

                const selectedStylist = stylistMatches[0];

                // 4. Find services using their exact names.
                const serviceDocuments = await db
                    .collection('services')
                    .find({ name: { $in: serviceNames } })
                    .toArray();

                const missingServices = serviceNames.filter(
                    name => !serviceDocuments.some(service => service.name === name)
                );

                if (missingServices.length > 0) {
                    return res.status(404).json({
                        error: 'Some services were not found.',
                        missingServices
                    });
                }

                if (
                    serviceNames.some(
                        name => serviceDocuments.filter(service => service.name === name).length > 1
                    )
                ) {
                    return res.status(409).json({
                        error: 'Service names are ambiguous. Use unique service IDs instead.'
                    });
                }

                // Preserve the service order from the request.
                const selectedServices = serviceNames.map(name =>
                    serviceDocuments.find(service => service.name === name)
                );

                // Supports specialties stored as either ObjectIds or {_id, name}.
                const specialtyIds = (selectedStylist.specialties ?? []).map(
                    specialty => String(specialty._id ?? specialty)
                );

                const unsupportedServices = selectedServices.filter(
                    service => !specialtyIds.includes(String(service._id))
                );

                if (unsupportedServices.length > 0) {
                    return res.status(400).json({
                        error: 'The stylist does not offer some selected services.',
                        services: unsupportedServices.map(service => service.name)
                    });
                }

                // 5. Calculate totals from database values.
                const totalDuration = selectedServices.reduce(
                    (total, service) => total + service.duration,
                    0
                );

                const totalPrice = Math.round(
                    selectedServices.reduce(
                        (total, service) => total + service.price,
                        0
                    ) * 100
                ) / 100;

                // 6. Create the appointment with embedded names and IDs.
                const now = new Date();

                const newAppointment = {
                    client: {
                        _id: client._id,
                        name: client.name
                    },
                    stylist: {
                        _id: selectedStylist._id,
                        name: selectedStylist.name
                    },
                    services: selectedServices.map(service => ({
                        _id: service._id,
                        name: service.name
                    })),
                    dateTime: appointmentDate,
                    totalDuration,
                    totalPrice,
                    status: 'pending',
                    createdAt: now,
                    updatedAt: now
                };

                const result = await db
                    .collection('appointments')
                    .insertOne(newAppointment);

                return res.status(201).json({
                    message: 'Appointment created successfully.',
                    appointmentId: result.insertedId
                });
            } catch (error) {
                console.error('Error creating appointment:', error);

                return res.status(500).json({
                    error: 'Internal server error'
                });
            }
        });


        app.patch('/appointments/:appointmentId', async (req, res) => {
            try {
                const { appointmentId } = req.params;
                const { dateTime, status } = req.body ?? {};

                if (!/^[a-fA-F0-9]{24}$/.test(appointmentId)) {
                    return res.status(400).json({
                        error: 'Invalid appointment ID.'
                    });
                }

                // Allow either rescheduling or cancellation in one request.
                if (dateTime !== undefined && status !== undefined) {
                    return res.status(400).json({
                        error: 'Provide either dateTime to reschedule or status to cancel.'
                    });
                }

                if (dateTime === undefined && status === undefined) {
                    return res.status(400).json({
                        error: 'Provide a new dateTime or status: "cancelled".'
                    });
                }

                if (status !== undefined && status !== 'cancelled') {
                    return res.status(400).json({
                        error: 'The only supported status update is "cancelled".'
                    });
                }

                const changes = {};

                if (dateTime !== undefined) {
                    if (
                        typeof dateTime !== 'string' ||
                        !/T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(dateTime)
                    ) {
                        return res.status(400).json({
                            error: 'Provide dateTime with a timezone, e.g. 2026-11-20T14:00:00+08:00.'
                        });
                    }

                    const newDateTime = new Date(dateTime);

                    if (Number.isNaN(newDateTime.getTime())) {
                        return res.status(400).json({
                            error: 'Invalid appointment date and time.'
                        });
                    }

                    if (newDateTime <= new Date()) {
                        return res.status(400).json({
                            error: 'Appointment date and time must be in the future.'
                        });
                    }

                    changes.dateTime = newDateTime;
                } else {
                    changes.status = 'cancelled';
                }

                const appointmentFilter = {
                    _id: new ObjectId(appointmentId)
                };

                const appointment = await db
                    .collection('appointments')
                    .findOne(appointmentFilter);

                if (!appointment) {
                    return res.status(404).json({
                        error: 'Appointment not found for this client.'
                    });
                }

                if (!['pending', 'confirmed'].includes(appointment.status)) {
                    return res.status(409).json({
                        error: 'Only pending or confirmed appointments can be updated.'
                    });
                }

                changes.updatedAt = new Date();

                // Recheck status during the update in case it changed.
                const result = await db.collection('appointments').updateOne(
                    {
                        ...appointmentFilter,
                        status: { $in: ['pending', 'confirmed'] }
                    },
                    { $set: changes }
                );

                if (result.matchedCount === 0) {
                    return res.status(409).json({
                        error: 'Appointment changed. Refresh and try again.'
                    });
                }

                return res.json({
                    message: status === 'cancelled'
                        ? 'Appointment cancelled successfully.'
                        : 'Appointment rescheduled successfully.'
                });
            } catch (error) {
                console.error('Error updating appointment:', error);

                return res.status(500).json({
                    error: 'Internal server error'
                });
            }
        });


        app.put('/appointments/:appointmentId', async (req, res) => {
            try {
                const { appointmentId } = req.params;
                const { phone, stylist, services, dateTime } = req.body ?? {};

                // 1. Validate inputs.
                if (!/^[a-fA-F0-9]{24}$/.test(appointmentId)) {
                    return res.status(400).json({
                        error: 'Invalid appointment ID.'
                    });
                }

                if (
                    typeof phone !== 'string' || !phone.trim() ||
                    typeof stylist !== 'string' || !stylist.trim() ||
                    !Array.isArray(services) || services.length === 0 ||
                    services.some(name =>
                        typeof name !== 'string' || !name.trim()
                    ) ||
                    typeof dateTime !== 'string'
                ) {
                    return res.status(400).json({
                        error: 'Provide phone, stylist, services, and dateTime.'
                    });
                }

                if (!/T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(dateTime)) {
                    return res.status(400).json({
                        error: 'dateTime must include a timezone, e.g. 2026-11-20T10:00:00+08:00.'
                    });
                }

                const appointmentDate = new Date(dateTime);

                if (
                    Number.isNaN(appointmentDate.getTime()) ||
                    appointmentDate <= new Date()
                ) {
                    return res.status(400).json({
                        error: 'Provide a valid future appointment date and time.'
                    });
                }

                const serviceNames = services.map(name => name.trim());

                if (new Set(serviceNames).size !== serviceNames.length) {
                    return res.status(400).json({
                        error: 'Duplicate services are not allowed.'
                    });
                }

                // 2. Find the existing appointment.
                const appointmentIdToModify = new ObjectId(appointmentId);

                const existingAppointment = await db
                    .collection('appointments')
                    .findOne({ _id: appointmentIdToModify });

                if (!existingAppointment) {
                    return res.status(404).json({
                        error: 'Appointment not found.'
                    });
                }

                if (!['pending', 'confirmed'].includes(existingAppointment.status)) {
                    return res.status(409).json({
                        error: 'Only pending or confirmed appointments can be updated.'
                    });
                }

                // 3. Find the client by phone.
                const clients = await db.collection('users')
                    .find(
                        { phone: phone.trim() },
                        { projection: { _id: 1, name: 1 } }
                    )
                    .limit(2)
                    .toArray();

                if (clients.length === 0) {
                    return res.status(404).json({
                        error: 'Client not found.'
                    });
                }

                if (clients.length > 1) {
                    return res.status(409).json({
                        error: 'Multiple clients share this phone number. Use a unique client ID.'
                    });
                }

                const client = clients[0];

                // 4. Find the stylist by exact name.
                const stylists = await db.collection('stylists')
                    .find({ name: stylist.trim() })
                    .limit(2)
                    .toArray();

                if (stylists.length === 0) {
                    return res.status(404).json({
                        error: 'Stylist not found.'
                    });
                }

                if (stylists.length > 1) {
                    return res.status(409).json({
                        error: 'Multiple stylists share this name. Use a unique stylist ID.'
                    });
                }

                const selectedStylist = stylists[0];

                // 5. Find all requested services.
                const serviceDocuments = await db.collection('services')
                    .find({ name: { $in: serviceNames } })
                    .toArray();

                const missingServices = serviceNames.filter(
                    name => !serviceDocuments.some(service => service.name === name)
                );

                if (missingServices.length > 0) {
                    return res.status(404).json({
                        error: 'Some services were not found.',
                        missingServices
                    });
                }

                if (
                    serviceNames.some(name =>
                        serviceDocuments.filter(service => service.name === name).length > 1
                    )
                ) {
                    return res.status(409).json({
                        error: 'Service names are ambiguous. Use unique service IDs.'
                    });
                }

                const selectedServices = serviceNames.map(name =>
                    serviceDocuments.find(service => service.name === name)
                );

                // Supports specialties stored as ObjectIds or {_id, name}.
                const specialtyIds = (selectedStylist.specialties ?? []).map(
                    specialty => String(specialty._id ?? specialty)
                );

                const unsupportedServices = selectedServices.filter(
                    service => !specialtyIds.includes(String(service._id))
                );

                if (unsupportedServices.length > 0) {
                    return res.status(400).json({
                        error: 'The stylist does not offer some selected services.',
                        services: unsupportedServices.map(service => service.name)
                    });
                }

                // 6. Recalculate totals using database values.
                const totalDuration = selectedServices.reduce(
                    (total, service) => total + service.duration,
                    0
                );

                const totalPrice = Math.round(
                    selectedServices.reduce(
                        (total, service) => total + service.price,
                        0
                    ) * 100
                ) / 100;

                const updates = {
                    client: {
                        _id: client._id,
                        name: client.name
                    },
                    stylist: {
                        _id: selectedStylist._id,
                        name: selectedStylist.name
                    },
                    services: selectedServices.map(service => ({
                        _id: service._id,
                        name: service.name
                    })),
                    dateTime: appointmentDate,
                    totalDuration,
                    totalPrice,
                    updatedAt: new Date()
                };

                // 7. Update the appointment, preserving status and createdAt.
                const result = await db.collection('appointments').updateOne(
                    {
                        _id: appointmentIdToModify,
                        status: { $in: ['pending', 'confirmed'] }
                    },
                    { $set: updates }
                );

                if (result.matchedCount === 0) {
                    return res.status(409).json({
                        error: 'Appointment changed. Refresh and try again.'
                    });
                }

                return res.status(200).json({
                    message: 'Appointment updated successfully.'
                });
            } catch (error) {
                console.error('Error updating appointment:', error);

                return res.status(500).json({
                    error: 'Internal server error'
                });
            }
        });


        //Delete record API
        app.delete('/appointments/:id', async (req, res) => {
            try {
                const appointmentId = req.params.id;

                // Attempt to delete the appointment
                const result = await db.collection('appointments').deleteOne({ _id: new ObjectId(appointmentId) });

                if (result.deletedCount === 0) {
                    return res.status(404).json({ error: 'Appointment not found' });
                }

                res.json({ message: 'Appointment deleted successfully' });
            } catch (error) {
                console.error('Error deleting appointment:', error);
                res.status(500).json({ error: 'Internal server error' });
            }
        });

        //Add users        
        app.use(express.json());

        app.post('/users', async (req, res) => {
            try {
                const { name, email, password, phone } = req.body ?? {};

                if (
                    typeof name !== 'string' || !name.trim() ||
                    typeof email !== 'string' || !email.trim() ||
                    typeof password !== 'string' || !password.trim() ||
                    typeof phone !== 'string' || !phone.trim()
                ) {
                    return res.status(400).json({
                        error: 'Name, email, password, and phone are required strings.'
                    });
                }

                const normalizedEmail = email.trim().toLowerCase();

                // Remove formatting: "+65 8000-1005" becomes "+6580001005".
                const normalizedPhone = phone.trim().replace(/[\s()-]/g, '');

                if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
                    return res.status(400).json({
                        error: 'Provide a valid email address.'
                    });
                }

                // Require international format, including the country code.
                if (!/^\+[1-9]\d{7,14}$/.test(normalizedPhone)) {
                    return res.status(400).json({
                        error: 'Provide phone in international format, e.g. +6580001005.'
                    });
                }

                if (
                    password.length < 8 ||
                    Buffer.byteLength(password, 'utf8') > 72
                ) {
                    return res.status(400).json({
                        error: 'Password must have at least 8 characters and at most 72 UTF-8 bytes.'
                    });
                }

                const now = new Date();

                const user = {
                    name: name.trim(),
                    email: normalizedEmail,
                    password: await bcrypt.hash(password, 12),
                    phone: normalizedPhone,
                    createdAt: now,
                    updatedAt: now
                };

                // Unique indexes enforce both constraints during insertion.
                const result = await db.collection('users').insertOne(user);

                return res.status(201).json({
                    message: 'User created successfully.',
                    user: {
                        _id: result.insertedId,
                        name: user.name,
                        email: user.email,
                        phone: user.phone,
                        createdAt: user.createdAt,
                        updatedAt: user.updatedAt
                    }
                });
            } catch (error) {
                if (error.code === 11000) {
                    const field = Object.keys(error.keyPattern ?? {})[0];

                    const message =
                        field === 'email'
                            ? 'Email address is already registered.'
                            : field === 'phone'
                                ? 'Phone number is already registered.'
                                : 'Email address or phone number is already registered.';

                    return res.status(409).json({ error: message });
                }

                console.error('Error creating user:', error);

                return res.status(500).json({
                    error: 'Internal server error'
                });
            }
        });

        app.post('/login', async (req, res) => {
            const { email, password } = req.body;
            if (!email || !password) {
                return res.status(400).json({ message: 'Email and password are required' });
            }
            const user = await db.collection('users').findOne({ email: email });
            if (!user) {
                return res.status(404).json({ message: 'User not found' });
            }
            const isPasswordValid = await bcrypt.compare(password, user.password);
            if (!isPasswordValid) {
                return res.status(401).json({ message: 'Invalid password' });
            }
            const accessToken = generateAccessToken(user._id, user.email);
            res.json({ accessToken: accessToken });
        });

        app.get('/profile', verifyToken, (req, res) => {
            res.json({ message: 'This is a protected route', user: req.user });
        });


        app.get("/ai/appointments", async function (req, res) {
            try {
                // more code here later
                const query = req.query.q;

                const allClients = await db.collection('users').distinct('name');
                const allStylists = await db.collection('stylists').distinct('name');
                const allServices = await db.collection('services').distinct('name');

                const searchParams = await generateSearchParams(query, allClients, allStylists, allServices);
                const criteria = {};

                if (searchParams.clients && searchParams.clients.length > 0) {
                    criteria["client.name"] = {
                        $in: searchParams.clients
                    }
                }

                if (searchParams.stylists && searchParams.stylists.length > 0) {
                    criteria["stylist.name"] = {
                        $in: searchParams.stylists
                    }
                }

                if (searchParams.services && searchParams.services.length > 0) {
                    criteria["services.name"] = {
                        $all: searchParams.services
                    }
                }

                if (searchParams.date) {
                    const start = new Date(`${searchParams.date}T00:00:00.000+08:00`);
                    const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);

                    criteria.dateTime = {
                        $gte: start,
                        $lt: end
                    };
                }

                if (searchParams.status) {
                    criteria.status = searchParams.status;
                }

                const appointments = await db.collection('appointments').find(criteria).toArray();
                res.json({
                    appointments
                })

            } catch (err) {
                console.error('AI search error:', err);

                const statusCode = [400, 422].includes(err.statusCode)
                    ? err.statusCode
                    : 500;

                return res.status(statusCode).json({
                    error: statusCode === 500
                        ? 'Server error performing AI search'
                        : err.message
                });
            }
        });

        app.post('/ai/appointments', async function (req, res) {
            try {
                const { appointmentText } = req.body ?? {};

                const [allClients, allStylists, allServices] = await Promise.all([
                    db.collection('users').distinct('name'),
                    db.collection('stylists').distinct('name'),
                    db.collection('services').distinct('name')
                ]);

                const extracted = await generateAppointment(
                    appointmentText,
                    allClients,
                    allStylists,
                    allServices
                );

                const [clients, stylists, serviceDocs] = await Promise.all([
                    db.collection('users')
                        .find(
                            { name: extracted.client },
                            { projection: { _id: 1, name: 1 } }
                        )
                        .limit(2)
                        .toArray(),

                    db.collection('stylists')
                        .find({ name: extracted.stylist })
                        .limit(2)
                        .toArray(),

                    db.collection('services')
                        .find({ name: { $in: extracted.services } })
                        .toArray()
                ]);

                if (clients.length !== 1 || stylists.length !== 1) {
                    return res.status(422).json({
                        error: 'Client or stylist name is missing or ambiguous. Use unique IDs.'
                    });
                }

                // Ensure every requested service resolves to exactly one document.
                if (
                    extracted.services.some(name =>
                        serviceDocs.filter(service => service.name === name).length !== 1
                    )
                ) {
                    return res.status(422).json({
                        error: 'A selected service is missing or has a duplicate name.'
                    });
                }

                const clientDoc = clients[0];
                const stylistDoc = stylists[0];

                const selectedServices = extracted.services.map(name =>
                    serviceDocs.find(service => service.name === name)
                );

                const specialtyIds = (stylistDoc.specialties ?? []).map(
                    specialty => String(specialty._id ?? specialty)
                );

                const unsupported = selectedServices.filter(
                    service => !specialtyIds.includes(String(service._id))
                );

                if (unsupported.length > 0) {
                    return res.status(422).json({
                        error: 'The stylist does not offer some selected services.',
                        services: unsupported.map(service => service.name)
                    });
                }

                const now = new Date();

                const appointment = {
                    client: {
                        _id: clientDoc._id,
                        name: clientDoc.name
                    },
                    stylist: {
                        _id: stylistDoc._id,
                        name: stylistDoc.name
                    },
                    services: selectedServices.map(service => ({
                        _id: service._id,
                        name: service.name
                    })),
                    dateTime: extracted.dateTime,
                    totalDuration: selectedServices.reduce(
                        (total, service) => total + service.duration,
                        0
                    ),
                    totalPrice: Math.round(
                        selectedServices.reduce(
                            (total, service) => total + service.price,
                            0
                        ) * 100
                    ) / 100,
                    status: 'pending',
                    createdAt: now,
                    updatedAt: now
                };

                const result = await db
                    .collection('appointments')
                    .insertOne(appointment);

                return res.status(201).json({
                    message: 'Appointment created successfully.',
                    appointmentId: result.insertedId,
                    appointment
                });
            } catch (error) {
                console.error('AI appointment creation failed:', error);

                const statusCode = [400, 422].includes(error.statusCode)
                    ? error.statusCode
                    : 500;

                return res.status(statusCode).json({
                    error: statusCode === 500
                        ? 'Server error creating appointment.'
                        : error.message
                });
            }
        });
        // START SERVER
        app.listen(3000, () => {
            console.log("Server has started on port 3000");
        });

    } catch (error) {
        console.error('Error connecting to MongoDB', error);
    }
}

main();
