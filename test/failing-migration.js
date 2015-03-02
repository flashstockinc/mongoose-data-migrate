'use strict';

exports.up = function (next) {
	console.log('    --> This is migration {{name}} being applied and failing');
	next(new Error('some_error from {{name}}'));
};


exports.down = function (next) {
	console.log('    --> This is migration {{name}} being rollbacked');
	next();
};
