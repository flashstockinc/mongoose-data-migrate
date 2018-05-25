'use strict';

var util = require('util'),
	fs = require('fs'),
	path = require('path'),

	mkdirp = require('mkdirp'),
	_ = require('lodash'),
	Q = require('q'),

	debug = require('debug')('mongoose-data-migrate'),

	schema = require('./schema'),

	/*eslint-disable func-style, brace-style*/
	migrationNoop = function migrationNoop(next) {next();},
	/*eslint-enable func-style, brace-style*/

	MODEL_NAME = '_migration_mongoose_migrate_',

	COLLECTION = 'migrations',

	mongoose,
	log,
	Migration;


exports.run = run;

/**
	@param {function} params.config - Config file
	@param {string} params.action
	@param {string} params.migration
	@param {string} params.folder - The folder to store migration files

	@param {boolean} [params.keepalive=false] - Private: `true` if the mongoose
	collection should be kept open
*/
function run(params, cliLog) {
	var config,
		promise;

	log = cliLog;

	if (params.action === 'create') {
		debug('Creating migration');
		return createMigrationFile(params.name, params.folder);
	}

	debug('Running init file');

	config = require(params.config);

	promise = getMongoose(config, params).then(function () {
		return initCollection(config.collection || COLLECTION);
	}).then(function () {
		if (params.action === 'up') {
			debug('Applying migrations');
			return applyMigrations(params.folder, config.applyOutOfOrderMigrations);
		} else if (params.action === 'down') {
			debug('Rolling back migrations');
			return rollbackMigrations(params.folder);
		}
	});

	promise.finally(function () {
		if (!params.keepalive) {
			debug('Closing mongoose connection');
			mongoose.connection.close();
		}
	});

	return promise;
}

function getMongoose(config, params) {
	var connectionDeferred,
		resolved;

	if (config.mongoose) {

		if (typeof config.mongoose === 'string') {
			resolved = path.resolve(config.mongoose);

			if (resolved !== config.mongoose) {
				resolved = path.join(path.dirname(params.config), config.mongoose);
			}

			debug('Loading mongoose from ' + resolved);
			mongoose = require(resolved);
		}

	} else {
		debug('Loading global mongoose');
		mongoose = require('mongoose');
	}


	debug('Connecting to mongo');

	mongoose.connect(config.db, config.dbOptions);

	connectionDeferred = Q.defer();

	if (mongoose.connection.readyState === 1) {
		debug('Connection open');
		connectionDeferred.resolve();
	}

	// TO DO: add a timeout here
	mongoose.connection
		.on('open', function () {
			debug('Connection open');
			connectionDeferred.resolve();
		})
		.on('error', connectionDeferred.reject);

	return connectionDeferred.promise;
}

function initCollection(collection) {
	if (mongoose.modelNames().indexOf(MODEL_NAME) > -1) {
		Migration = mongoose.model(MODEL_NAME);
	} else {
		Migration = mongoose.model(MODEL_NAME, schema(mongoose, collection));
	}

	return Migration.findById(Migration.CONTROL_DOC).exec().then(function (controlDoc) {
		if (controlDoc == null) {
				debug('Creating control doc');

				controlDoc = new Migration({
					_id: Migration.CONTROL_DOC,
				});

			return savePromise(controlDoc);
		} else {
			debug(
				'Migrations collection \'' + collection + '\' already initialized'
			);
		}
	});
}

function createMigrationFile(title, folder) {
	var now = new Date(),
		baseName = util.format('%s-%s-%s-%s%s',
			now.getFullYear(), pad(now.getMonth() + 1), pad(now.getDate()),
			pad(now.getHours()), pad(now.getMinutes())
		),
		name;

	return Q.nfcall(mkdirp, folder).then(function () {
		return Q.all([
			Q.nfcall(fs.readdir, folder),
			Q.nfcall(fs.readFile, path.join(__dirname, './template.js'), 'utf8')
		]);
	}).spread(function (files, content) {
		var suffix = '',
			i = 1;

		do {
			name = baseName + suffix;
			suffix = '-' + i++;
		} while (files.indexOf(name + '.js') > -1);

		name += (title ? '-' + title : '') + '.js';

		return Q.nfcall(fs.writeFile,
			path.join(folder, name),
			content.replace(/\{\{name\}\}/g, name)
		);

	}).then(function () {
		log.ok('New migration created: ' + name);
	});
}

function applyMigrations(folder, applyOutOfOrderMigrations) {
	return Q.all([
		Migration.findById(Migration.CONTROL_DOC).exec(),
		getMigrations(folder),
		// TO DO: handle failed rollback
	]).spread(function (controlDoc, migrationFiles) {
		var migrations = migrationFiles.map(normalizeMigrationName),
			appliedMigrations = controlDoc.migrations,
			lastRunIndex = lastRun(migrations, appliedMigrations),
			migrationsToRun;

		if (lastRunIndex > -1) {
			if (!applyOutOfOrderMigrations) {
				migrationsToRun = migrations.slice(lastRunIndex + 1);
			} else {
				migrationsToRun = _.difference(migrations, appliedMigrations);
			}
		} else {
			migrationsToRun = migrations;
		}

		migrationsToRun = migrationsToRun.map(function (m) {
			return {
				module: require(path.join(folder, m)),
				name: normalizeMigrationName(m)
			};
		});

		return runMigrations(
			migrationsToRun,
			controlDoc, {
				direction: Migration.DIRECTION.UP,
				onError: function (err, failedBatch, migration) {
					failedBatch.status = Migration.STATUS.FAILED;
					return savePromise(failedBatch).then(function () {
						log.error('Migration ' + migration + ' failed, rolling back...');
						log.error(err.stack);
						return rollbackMigrations(folder, true);
					});
				}
		});
	});
}

function rollbackMigrations(folder, isError) {
	var controlDocPromise =
		Migration.findById(Migration.CONTROL_DOC).exec(),

		batchPromise = Q.when(controlDocPromise).then(function (controlDoc) {
			return Q.all([
				Migration.findById(controlDoc.batch._id).exec(),
				Migration.findOne({
					_id: controlDoc.lastBatch._id,
					status: Migration.STATUS.FAILED,
				}).exec(),
			]);
		}).spread(function (alive, last) {
			if (!(last || alive)) throw new MigrationError('No migrations to rollback!');
			return last || alive;
		});

	return Q.all([
		controlDocPromise,
		getMigrations(folder),
		batchPromise,
	]).spread(function (controlDoc, migrationFiles, batch) {

		var migrations = migrationFiles.map(normalizeMigrationName),
			migrationsToRollback;

		if (batch.status === Migration.STATUS.FAILED) {
			// Failed migration, rollback it
			if (batch.direction === Migration.DIRECTION.UP) {
				migrationsToRollback = batch.migrations.slice(
					0, batch.migrations.indexOf(batch.migration) + 1
				).reverse();
			// Pending rollback, recover
			} else {
				migrationsToRollback = batch.migrations.slice(
					batch.migrations.indexOf(batch.migration) + 1
				);
			}
		} else {
			migrationsToRollback = batch.migrations.slice().reverse();
		}

		migrationsToRollback = migrationsToRollback.map(function (migration) {
			var index = migrations.indexOf(migration);

			return {
				module: require(path.join(folder, migrationFiles[index])),
				name: migration
			};
		});

		return runMigrations(
			migrationsToRollback,
			controlDoc, {
				pending:
					batch.direction === Migration.DIRECTION.DOWN && batch,
				direction: Migration.DIRECTION.DOWN,

				onError: function (err, failedBatch, migration) {
					failedBatch.status = Migration.STATUS.FAILED;
					return savePromise(failedBatch).then(function () {
						throw new MigrationError(
							'Rollback for ' + migration + ' failed',
							err
						)
					});
				}
			}
		);

	}).then(function () {
		if (isError) {
			throw new MigrationError('Rolled back on error!');
		}
	});
}

function runMigrations(migrationsToRun, controlDoc, options) {
	var batch = options.pending || new Migration({
		_id: new mongoose.Types.ObjectId(),
		direction: options.direction,
		migration: null,
		at: new Date(),
		migrations: _.pluck(migrationsToRun, 'name'),
		status: Migration.STATUS.PENDING,
		prevBatch: {
			_id: controlDoc.batch._id,
			at: controlDoc.batch.at
		}
	}),
		doing = options.direction === Migration.DIRECTION.UP ? 'Applying': 'Rolling back',
		done = options.direction === Migration.DIRECTION.UP ? 'Applied': 'Rolled back',
		promise = Q.when();


	controlDoc.lastBatch = {
		_id: batch._id,
		at: batch.at
	};
	if (options.direction === Migration.DIRECTION.UP) {
		controlDoc.batch = controlDoc.lastBatch;
	} else if (!options.pending) {
		promise = Migration.findById(controlDoc.batch._id).exec()
			.then(function (previous) {
				controlDoc.batch._id = previous.prevBatch._id;
				controlDoc.batch.at = previous.prevBatch.at;
			});
	}

	function runMigrationLoop(i, deferred) {
		var name;

		save().then(function (saved) {
			batch = saved[0];
			controlDoc = saved[1];

			if (i >= migrationsToRun.length) {
				return endBatch(i, deferred);
			} else {
				var module = migrationsToRun[i].module[options.direction] || migrationNoop;
				name = migrationsToRun[i].name;

				return runNext(module, name);
			}
		}).then(function (migrated) {
			if (!migrated) return;

			runMigrationLoop(i + 1, deferred);
		}).then(null, function (err) {
			onError(err, name, deferred);
		});
	}

	function save() {
		return Q.all([
			savePromise(batch),
			savePromise(controlDoc),
		]).then(null, function (err) {
			err = err || new Error();
			err.saving = true;
			throw err;
		});
	}

	function runNext(module, name) {
		debug(doing + ' migration ' + name);
		return Q.nfcall(module).then(function () {
			log.ok(done + ' migration ' + name);

			batch.at = new Date();
			batch.migration = name;

			controlDoc.lastBatch.at = batch.at;

			if (options.direction === Migration.DIRECTION.UP) {
				controlDoc.migrations.push(name);
				controlDoc.batch.at = batch.at;
			} else {
				controlDoc.migrations.pop();
			}

			return true;
		}, function (err) {
			err = err || new Error();
			err.running = true;
			throw err;
		});
	}

	function endBatch(i, deferred) {
		if (i > migrationsToRun.length) return null;
		var endPromise;

		batch.status = Migration.STATUS.COMPLETED;

		endPromise = savePromise(batch);

		return endPromise.then(function () {
			log.ok('All done');
			deferred.resolve();
			return null;
		});
	}

	function onError(err, name, deferred) {
		if (err && err.running) {
			if (options.onError) {
				deferred.resolve(options.onError(err, batch, name));
			} else {
				deferred.reject(new MigrationError(util.format(
					'Migration %s failed\n\nOriginal stack:\n%s',
					name, err.message
				)));
			}
		} else if (err && err.saving) {
			deferred.reject(new MigrationError(util.format(
				'Saving details for migration %s failed\n\nOriginal stack:\n%s',
				name, err.message
			)));
		} else {
			deferred.reject(err);
		}
	}

	return promise.then(function () {
		var deferred = Q.defer();

		runMigrationLoop(0, deferred);

		return deferred.promise;
	});
}

/**
	@returns {number} - index of the last 'old' migration on onDisk. 'old' means
	that the migration is run, or some newer migration is
*/
function lastRun(onDisk, onDb) {
	if (!onDb.length) return -1;

	for (var i = onDisk.length - 1; i >= 0; i--) {
		if (onDisk[i] <= onDb[onDb.length - 1]) {
			return i;
		}
	}

	return -1;
}

function getMigrations(folder) {
	return Q.nfcall(fs.readdir, folder).then(function (files) {

		return _(files).chain()
			.filter(function (fileName) {
				return fileName.match(/\.js$/);
			})
			.sortBy(function (fileName) {
				return fileName.match(/^(.+)\.js$/)[1];
			})
			.value();
	});
}

function normalizeFilename(fileName) {
	if (fileName.match(/\.js$/)) {
		return fileName;
	} else {
		return fileName + '.js';
	}
}

function normalizeMigrationName(name) {
	return path.basename(name.match(/([^\/]+)$/)[1], '.js');
}

function pad(number) {
	if (number < 10) {
		return '0' + number;
	} else {
		return number;
	}
}

function savePromise(doc) {

	var deferred = Q.defer();

	doc.save(function (err, saved) {
		if (err != null) {
			deferred.reject(err);
		} else {
			deferred.resolve(Migration.findById(saved._id).exec());
		}
	});

	return deferred.promise;
}

function MigrationError(message, original) {
	var err = new Error(message);
	err.migration = true;
	err.original = original;
	Error.captureStackTrace(err, MigrationError);
	return err;
}
