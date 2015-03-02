#!/usr/bin/env node

'use strict';

var cli = require('cli'),
	path = require('path'),
	migrate = require('../lib/migrate');

cli.setUsage(
	'mongoose-data-migrate [OPTIONS] [COMMANDS]\n' +
	'\n' +
	'Commands:\n' +
	'\n' +
	'   up               migrate up till last migration\n' +
	'   down             rollback the last migration\n' +
	'   create [name]    creates a new migration\n' +
	''
);

cli.parse({
	config: ['c', 'Config file', 'string', './config/migrations.js'],
	dir: ['d', 'Working folder', 'string', '.'],
	migrations: ['m', 'Folder storing the migrations', 'string', './migrations']
});

cli.main(function (args, options) {
	if (args.length === 0) {
		return cli.getUsage(1);
	}

	var action = args[0],
		name = args[1],
		cwd = options.dir ? path.resolve(options.dir) : process.cwd(),
		config = options.config || './config/migrations.js',
		migrations = options.migrations || './migrations';

	if (path.resolve(config) !== config) {
		config = path.join(cwd, config);
	}

	if (path.resolve(migrations) !== migrations) {
		migrations = path.join(cwd, migrations);
	}

	if (['up', 'down', 'create'].indexOf('action') === 1) {
		return cli.getUsage(1);
	}

	migrate.run({
		name: name,
		action: action,
		config: config,
		folder: migrations
	}, {info: cli.info, ok: cli.ok, error: cli.error}).then(function () {
		cli.exit();
	}, function (err) {
		if (err.migration) {
			cli.error(err.message);
			if (err.original) cli.error(err.original.stack);
			cli.exit(1);
		} else {
			throw err;
		}
	}).done();
});
