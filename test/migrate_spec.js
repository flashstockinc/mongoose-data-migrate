'use strict';

var mongo = require('mongodb'),
	mongoose = require('mongoose'),
	fs = require('fs'),
	Q = require('q'),
	_ = require('lodash'),
	rimraf = require('rimraf'),
	path = require('path'),

	migrate = require('../lib/migrate'),
	schema = require('../lib/schema'),

	template = fs.readFileSync(path.join(__dirname, '../lib/template.js'), 'utf8'),
	failingMigrationTpl = fs.readFileSync(path.join(__dirname, 'failing-migration.js'), 'utf8'),
	failingRollbackTpl = fs.readFileSync(path.join(__dirname, 'failing-rollback.js'), 'utf8'),
	failingMigrationRollbackTpl = fs.readFileSync(
		path.join(__dirname, 'failing-migration-rollback.js'), 'utf8'
	),

	CONNECTION = require('./config').db,

	db;


function findMigrations() {
	return Q.ninvoke(db.collection('migrations'), 'find').then(function (cursor) {
		return Q.ninvoke(cursor, 'toArray');
	}).then(function (migrations) {
		return Q.all([
			_.find(migrations, {_id: schema.CONTROL_DOC}),
			_.chain(migrations)
				.filter(function (migration) {
					return migration._id !== schema.CONTROL_DOC;
				})
				.sortBy(function (migration) {
					return migration.at;
				})
				.value()
		]);
	});
}

function createMigrations() {
	purgeMigrations();
	try {
		fs.mkdirSync(path.join(__dirname, 'migrations'));
	} catch (e) {
		// Nothing
	}

	var args = _.toArray(arguments),
		migrations;

	if (args.length > 1) {
		migrations = args;
	} else if (!Array.isArray(args[0])) {
		migrations = [args[0]];
	} else {
		migrations = args[0];
	}

	migrations.forEach(function (migration) {
		var name,
			directions,
			text;

		if (typeof migration === 'string') {
			name = migration;
			directions = [true, true];
		} else {
			name = Object.keys(migration)[0];
			directions = migration[name];
		}

		if (typeof directions === 'boolean') {
			directions = [directions, true];
		} else if (directions[1] == null) {
			directions = [directions[0], true];
		}

		switch (2*(+directions[0]) + (+directions[1])) {
			// false-false
			case 0: {
				text = failingMigrationRollbackTpl;
				break;
			}
			// false-true
			case 1: {
				text = failingMigrationTpl;
				break;
			}
			// true-false
			case 2: {
				text = failingRollbackTpl;
				break;
			}
			// true-true
			case 3: {
				text = template;
				break;
			}
		}

		text = text.replace(/\{\{name\}\}/g, name);

		fs.writeFileSync(
			path.join(__dirname, 'migrations', name + '.js'),
			text
		);
	});
}

function expectBatchesToBeConsistent(controlDoc, batches) {
	batches = _.sortBy(batches, 'at');

	var batch,
		migrations = [];

	// The migration history has to be consistent
	batch = _.find(batches, sameId(controlDoc.batch));

	while (batch) {
		if (batch.migration) {
			migrations = batch.migrations
				.slice(0, batch.migrations.indexOf(batch.migration) + 1)
				.concat(migrations);
		}

		batch = batch.prevBatch && _.find(batches, sameId(batch.prevBatch));
	}

	expect(migrations).toEqual(controlDoc.migrations);

	// The lastBatch field corresponds to the actual last batch
	batch = _.last(batches);
	expect(batch.at).toEqual(controlDoc.lastBatch.at);
	expect(batch._id.str).toEqual(controlDoc.lastBatch._id.str);

	// If `batch` field is present, it should be consistent
	if (controlDoc.batch && controlDoc.batch._id) {
		batch = _.find(batches, sameId(controlDoc.batch));

		expect(batch).toBeDefined();
		expect(batch.direction).toBe('up');
		expect(batch.at).toEqual(controlDoc.batch.at);
	}

	// All completed batches should point the to their last migration
	batches.filter(function (batch) {
		return batch.status === schema.STATUS.COMPLETED;
	}).forEach(function (batch) {
		expect(batch.migration).toEqual(_.last(batch.migrations));
	});

	// All 'down' batches must mirror some 'up' batch
	batches.filter(function (batch) {
		return batch.direction === 'down';
	}).forEach(function (batch) {
		expect(batch.prevBatch).toBeDefined();
		var reverse = _.find(batches, sameId(batch.prevBatch));

		expect(reverse).toBeDefined();

		if (reverse.status === schema.STATUS.COMPLETED) {
			expect(reverse.migrations.slice().reverse()).toEqual(batch.migrations);
		} else {
			expect(
				reverse.migrations.slice(0, reverse.migrations.indexOf(reverse.migration) + 1)
			).toEqual(batch.migrations);
		}
	});

	// There shouldn't be more than 1 pending migration
	expect(_.countBy(batches, 'status')[schema.STATUS.PENDING] || 0).toBeLessThan(1);
}

function purgeMigrations() {
	Object.keys(require.cache).filter(function (key) {
		return key.match(path.join(__dirname, 'migrations'));
	}).forEach(function (key) {
		delete require.cache[key];
	});
}

function sameId(batch) {
	return function hasSameId(b) {
		return b._id.equals(batch._id);
	};
}

function shouldFail() {
	throw new Error('It should fail!');
}

describe('migrate', function () {
	var params,
		log = {
			ok: jasmine.createSpy(),
			info: jasmine.createSpy(),
			error: jasmine.createSpy()
		},
		migrationsFolder = path.join(__dirname, 'migrations');

	function run(action) {
		params.action = action || 'up';
		return migrate.run(params, log);
	}

	beforeEach(function (done) {
		mongo.MongoClient.connect(CONNECTION, function (err, database) {
			if (err) return done(err);
			db = database;
			done();
		});
	});

	beforeEach(function () {
		params = {
			config: path.join(__dirname, 'config.js'),
			folder: migrationsFolder,
			action: 'up',
			keepalive: true
		};
	});

	afterEach(function (done) {
		Q.all([
			Q.nfcall(rimraf, migrationsFolder),
			Q.ninvoke(db.collection('migrations'), 'drop').then(null, function (err) {
				if (!err.message.match('ns not found')) throw err;
			}).then(function () {
				return Q.ninvoke(db, 'close');
			})
		]).then(function () {
			done();
		}, done);
	});

	it('should create a migration', function (done) {
		params.name = 'asf';
		run('create').then(function () {
			var files = fs.readdirSync(migrationsFolder),
				file = files[0];
			expect(files.length).toBe(1);
			expect(file).toMatch(/\d{4}-\d{2}-\d{2}-\d{4}-asf\.js/);
			done();
		}).then(null, done);
	});

	it('should run a migration', function (done) {
		createMigrations('1', '2', '3', '4', '5');
		run()
			.then(findMigrations)
			.spread(function (controlDoc, batches) {
				expect(batches.length).toBe(1);
				expect(batches[0].migrations.length).toBe(5);


				expectBatchesToBeConsistent(controlDoc, batches);

				done();
			})
			.then(null, done);
	});

	it('should run several migrations', function (done) {
		createMigrations('1');
		run()
			.then(function () {
				return run();
			})
			.then(function () {
				createMigrations('2', '3');
				return run();
			})
			.then(findMigrations)
			.spread(function (controlDoc, batches) {
				expect(batches.length).toBe(3);
				expect(batches[0].migrations.length).toBe(1);
				expect(batches[1].migrations.length).toBe(0);
				expect(batches[2].migrations.length).toBe(2);
				expectBatchesToBeConsistent(controlDoc, batches);
				done();
			})
			.then(null, done);
	});

	it('should ignore migrations which are too old to be run', function (done) {
		createMigrations('1', '3');
		run()
			.then(function () {
				createMigrations('2', '4');
				return run();
			})
			.then(findMigrations)
			.spread(function (controlDoc, batches) {
				expect(controlDoc.migrations).toEqual(['1', '3', '4']);
				expectBatchesToBeConsistent(controlDoc, batches);
				done();
			}).then(null, done);
	});

	it('should run migrations in a consistent order', function (done) {
		createMigrations('1', '4');
		run()
			.then(function () {
				fs.unlinkSync(path.join(__dirname, 'migrations/4.js'));
				createMigrations('2', '3');
				return run();
			})
			.then(findMigrations)
			.spread(function (controlDoc, batches) {
				expect(batches.length).toBe(2);
				expect(controlDoc.migrations).toEqual(['1', '4']);
				expectBatchesToBeConsistent(controlDoc, batches);
				done();
			})
			.then(null, done);
	});

	it('should rollback migrations', function (done) {
		createMigrations('1', '2');
		run()
			.then(function () {
				return run('down');
			})
			.then(function () {
				createMigrations('3', '4');
				return run();
			})
			.then(findMigrations)
			.spread(function (controlDoc, batches) {
				expect(batches.length).toBe(3);
				expectBatchesToBeConsistent(controlDoc, batches);
				done();
			})
			.then(null, done);
	});

	it('should rollback several migrations', function (done) {
		createMigrations('1', '2');
		run()
			.then(function () {
				return run('down');
			})
			.then(function () {
				return run();
			})
			.then(function () {
				return run('down');
			})
			.then(function () {
				createMigrations('3');
				return run();
			})
			.then(function () {
				return run('down');
			})
			.then(function () {
				return run();
			})
			.then(findMigrations)
			.spread(function (controlDoc, batches) {
				expect(batches.length).toBe(7);
				expect(controlDoc.migrations.length).toBe(3);
				expectBatchesToBeConsistent(controlDoc, batches);
				done();
			})
			.then(null, done);
	});

	it('should recover from failed rollbacks', function (done) {
		createMigrations('1', '2');
		run()
			.then(function () {
				createMigrations({1: [true, false]});
				return run('down');
			})
			.then(shouldFail, function (err) {
				expect(err).toBeDefined();
				expect(err.message).toMatch(/Rollback for .* failed/);
			})
			.then(function () {
				return run('down');
			})
			.then(shouldFail, function (err) {
				expect(err).toBeDefined();
				expect(err.message).toMatch(/Rollback for .* failed/);
			})
			.then(function () {
				createMigrations('1');
				return run('down');
			})
			.then(findMigrations)
			.spread(function (controlDoc, batches) {
				expect(batches.length).toBe(2);
				expect(controlDoc.migrations.length).toBe(0);
				expectBatchesToBeConsistent(controlDoc, batches);
				done();
			})
			.then(null, done);
	});

	it('should throw if no migrations to rollback', function (done) {
		createMigrations('1');
		run()
			.then(function () {
				return run('down');
			})
			.then(function () {
				return run('down');
			})
			.then(shouldFail, function (err) {
				expect(err).toBeDefined();
				expect(err.migration).toBe(true);
				done();
			})
			.then(null, done);
	});

	it('should rollback failed migrations', function (done) {
		createMigrations('1', '2');
		run()
			.then(function () {
				createMigrations({3: [false]});
				return run();
			})
			.then(shouldFail, function (err) {
				expect(err).toBeDefined();
				expect(err.message).toMatch(/Rollbacked on error/);
			})
			.then(findMigrations)
			.spread(function (controlDoc, batches) {
				expect(batches.length).toBe(3);
				expect(controlDoc.migrations).toEqual(['1', '2']);
				expectBatchesToBeConsistent(controlDoc, batches);
				done();
			})
			.then(null, done);
	});

	it('should rollback failed migrations partially applied', function (done) {
		createMigrations('1', '2');
		run()
			.then(function () {
				createMigrations('3', {4: [false]});
				return run();
			})
			.then(shouldFail, function (err) {
				expect(err).toBeDefined();
				expect(err.message).toMatch(/Rollbacked on error/);
			})
			.then(findMigrations)
			.spread(function (controlDoc, batches) {
				expect(batches.length).toBe(3);
				expectBatchesToBeConsistent(controlDoc, batches);
				done();
			})
			.then(null, done);
	});

	it('should keep it together in a super-complicated test', function (done) {
		createMigrations('1');
		run()
			.then(function () {
				createMigrations('2', '3');
				return run();
			})
			.then(function () {
				return run();
			})
			.then(function () {
				createMigrations('4');
				return run();
			})
			.then(function () {
				return run('down');
			})
			.then(function () {
				createMigrations({5: false});
				return run();
			})
			.then(shouldFail, function (err) {
				expect(err).toBeDefined();
				expect(err.message).toMatch(/Rollbacked on error/);
			})
			.then(function () {
				createMigrations('5');
				return run();
			})
			.then(findMigrations)
			.spread(function (controlDoc, batches) {
				expect(batches.length).toBe(8);
				expect(controlDoc.migrations).toEqual(['1', '2', '3', '4', '5']);
				expectBatchesToBeConsistent(controlDoc, batches);
				done();
			})
			.then(null, done);
	});

	it('fake test to do afterAll', function () {
		mongoose.connection.close();
	});
});
