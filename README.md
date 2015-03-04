
# mongoose-data-migrate

<!--
[![NPM](https://nodei.co/npm/mongoose-data-migrate.png?downloads=true&downloadRank=true)](https://nodei.co/npm/mongoose-data-migrate/)
-->

Mongodb data migration tool using node.js and mongoose. Heavily inspired by [madhums/mongoose-migrate](https://github.com/madhums/mongoose-migrate).

At a high level, here's how you use it:

1. run 'mongoose-data-migrate create my-migration1' to create your migration files.  The files are created in the _migrations_ folder in the root of your project.
2. implement the up and down methods in each migration file.
3. running 'mongoose-data-migrate up' will run all migration files that are in the _migrations_ folder that have not yet been run.
4. running 'mongoose-data-migrate down' will execute the _down_ method on all migration to the point that the previous 'migrate up' was run.


## Installation

    $ npm install -g mongoose-data-migrate
		
## Usage

```
Usage: mongoose-data-migrate [up|down|create] 

Commands:

   up               run all new migrations since the previous run
   down             migrate down to the point of the previous migrate up
   create [title]   create a new migration file with optional [title]
```

## Config file
mongoose-data-migrate will store the current state of migrations in a collection in mongodb. Therefore, a config file is required in order to provide the connection details to the mongodb instance.

Place the config file in the root of your project as ./config/migrations.js

The config file format is:

```
module.exports = {

	// The location of the the mongoose module. Since mongoose-data-migrate
	// needs to make a connection to mongodb, if you point to it here you'll
	// be able to use the same connection in your migration files rather than
	// creating your own connection.
	mongoose: '../node_modules/mongoose',

	// mongodb connection string in mongoose format: 'mongodb://username:password@host:port/database?options...'
	// See: http://mongoosejs.com/docs/connections.html
	db: 'mongodb://localhost:27017',

	// Name for the migrations collection (defaults to 'migrations')
	collection: 'migrations'
};
```

## Mongoose Compatability

So far mongoose-data-migrate has only been tested with Mongoose 3.8.x.


## Testing
In order to run the test specs you need to have:

1. an instance of mongodb running at `localhost:27017`.
2. a db named 'mongoose_data_migrate_test' without any credentials

To run the tests:

```
npm test
```
