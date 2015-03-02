'use strict';

var CONTROL_DOC = '__control_doc_id__',
	STATUS = {
		COMPLETED: 'Completed',
		PENDING: 'Pending',
		FAILED: 'Failed',
	};

function schemaFn(mongoose, collection) {
	var schema = new mongoose.Schema({
		_id: {},

		// For control doc: sorted list of all alive migrations
		// For batches: sorted list of all migrations to be run in
		// this batch
		migrations: [String],

		// Control doc only
		// The last attempted batch, completed or not
		lastBatch: {
			_id: mongoose.Schema.ObjectId,
			at: Date
		},
		// The last fully alive batch, that is, the last completed 'up' batch
		// that hasn't been rollbacked.
		// This is basically the tail of the migration history
		batch: {
			_id: mongoose.Schema.ObjectId,
			at: Date
		},


		// Batches only

		at: Date,
		// Last run/rollbacked migration of this batch
		migration: String,
		status: String,
		direction: String,
		// The batch this one is continuing or rollbacking
		prevBatch: {
			_id: mongoose.Schema.ObjectId,
			migration: String,
			at: Date
		},
	}, {strict: false, collection: collection});

	schema.statics.STATUS = STATUS;
	schema.statics.DIRECTION = {
		UP: 'up',
		DOWN: 'down'
	};
	schema.statics.CONTROL_DOC = CONTROL_DOC;
	return schema;
}

// For testing
schemaFn.CONTROL_DOC = CONTROL_DOC;
schemaFn.STATUS = STATUS;

module.exports = schemaFn;
