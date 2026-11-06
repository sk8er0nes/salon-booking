const { MongoClient, ServerApiVersion } = require('mongodb');

let client = null;

async function connect(uri, dbname) {
  if (client) {
    return client.db(dbname);
  }

  client = new MongoClient(uri, {
    serverApi: {
      version: ServerApiVersion.v1
    },
  });

  await client.connect();
  //console.log('Connected to MongoDB');
 
  return client.db(dbname);
}

module.exports = { connect};