/*!
 * Copyright 2015 Google Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/*!
 * @module common/grpc-service
 */

'use strict';

var extend = require('extend');
var googleProtoFiles = require('google-proto-files');
var grpc = require('grpc');
var is = require('is');
var nodeutil = require('util');
var path = require('path');
var retryRequest = require('retry-request');
var through = require('through2');
var dotProp = require('dot-prop');

/**
 * @type {module:common/service}
 * @private
 */
var Service = require('./service.js');

/**
 * @const {object} - A map of protobuf codes to HTTP status codes.
 * @private
 */
var GRPC_ERROR_CODE_TO_HTTP = {
  0: {
    code: 200,
    message: 'OK'
  },

  1: {
    code: 499,
    message: 'Client Closed Request'
  },

  2: {
    code: 500,
    message: 'Internal Server Error'
  },

  3: {
    code: 400,
    message: 'Bad Request'
  },

  4: {
    code: 504,
    message: 'Gateway Timeout'
  },

  5: {
    code: 404,
    message: 'Not Found'
  },

  6: {
    code: 409,
    message: 'Conflict'
  },

  7: {
    code: 403,
    message: 'Forbidden'
  },

  8: {
    code: 429,
    message: 'Too Many Requests'
  },

  9: {
    code: 412,
    message: 'Precondition Failed'
  },

  10: {
    code: 409,
    message: 'Conflict'
  },

  11: {
    code: 400,
    message: 'Bad Request'
  },

  12: {
    code: 501,
    message: 'Not Implemented'
  },

  13: {
    code: 500,
    message: 'Internal Server Error'
  },

  14: {
    code: 503,
    message: 'Service Unavailable'
  },

  15: {
    code: 500,
    message: 'Internal Server Error'
  },

  16: {
    code: 401,
    message: 'Unauthorized'
  }
};

/**
 * Service is a base class, meant to be inherited from by a "service," like
 * BigQuery or Storage.
 *
 * This handles making authenticated requests by exposing a `makeReq_` function.
 *
 * @constructor
 * @alias module:common/grpc-service
 *
 * @param {object} config - Configuration object.
 * @param {string} config.baseUrl - The base URL to make API requests to.
 * @param {string[]} config.scopes - The scopes required for the request.
 * @param {string} config.service - The name of the service.
 * @param {object=} config.protoServices - Directly provide the required proto
 *     files. This is useful when a single class requires multiple services.
 * @param {object} options - [Configuration object](#/docs/?method=gcloud).
 */
function GrpcService(config, options) {
  if (global.GCLOUD_SANDBOX_ENV) {
    // gRPC has a tendency to cause our doc unit tests to fail, so we prevent
    // any calls to that library from going through.
    // Reference: https://github.com/GoogleCloudPlatform/gcloud-node/pull/1137#issuecomment-193315047
    return global.GCLOUD_SANDBOX_ENV;
  }

  Service.call(this, config, options);

  if (config.customEndpoint) {
    this.grpcCredentials = grpc.credentials.createInsecure();
  }

  this.maxRetries = options.maxRetries;

  var apiVersion = config.apiVersion;
  var service = this.service = config.service;

  this.activeServiceMap_ = new Map();
  this.protos = {};

  var protoServices = config.protoServices;

  if (!protoServices) {
    protoServices = {};
    protoServices[service] = googleProtoFiles[service][apiVersion];
  }

  for (var protoServiceName in protoServices) {
    var protoService = this.loadProtoFile_(
      protoServices[protoServiceName], config);

    this.protos[protoServiceName] = protoService;
  }
}

nodeutil.inherits(GrpcService, Service);

/**
 * Make an authenticated request with gRPC.
 *
 * @param {object} protoOpts - The proto options.
 * @param {string} protoOpts.service - The service name.
 * @param {string} protoOpts.method - The method name.
 * @param {number=} protoOpts.timeout - After how many milliseconds should the
 *     request cancel.
 * @param {object} reqOpts - The request options.
 * @param {function=} callback - The callback function.
 */
GrpcService.prototype.request = function(protoOpts, reqOpts, callback) {
  if (global.GCLOUD_SANDBOX_ENV) {
    return global.GCLOUD_SANDBOX_ENV;
  }

  var self = this;

  if (!this.grpcCredentials) {
    // We must establish an authClient to give to grpc.
    this.getGrpcCredentials_(function(err, credentials) {
      if (err) {
        callback(err);
        return;
      }

      self.grpcCredentials = credentials;
      self.request(protoOpts, reqOpts, callback);
    });

    return;
  }

  // Clean up gcloud-specific options.
  delete reqOpts.autoPaginate;
  delete reqOpts.autoPaginateVal;

  var service = this.getService_(protoOpts);
  var grpcOpts = {};

  if (is.number(protoOpts.timeout)) {
    grpcOpts.deadline = GrpcService.createDeadline_(protoOpts.timeout);
  }

  // Retains a reference to an error from the response. If the final callback is
  // executed with this as the "response", we return it to the user as an error.
  var respError;

  var retryOpts = {
    retries: this.maxRetries,
    shouldRetryFn: GrpcService.shouldRetryRequest_,

    // retry-request determines if it should retry from the incoming HTTP
    // response status. gRPC always returns an error proto message. We pass that
    // "error" into retry-request to act as the HTTP response, so it can use the
    // status code to determine if it should retry.
    request: function(_, onResponse) {
      respError = null;

      service[protoOpts.method](reqOpts, grpcOpts, function(err, resp) {
        if (err) {
          respError = GrpcService.getError_(err);

          if (respError) {
            onResponse(null, respError);
            return;
          }

          onResponse(err, resp);
          return;
        }

        onResponse(null, resp);
      });
    }
  };

  retryRequest(null, retryOpts, function(err, resp) {
    if (!err && resp === respError) {
      err = respError;
      resp = null;
    }

    callback(err, resp);
  });
};

/**
 * Make an authenticated streaming request with gRPC.
 *
 * @param {object} protoOpts - The proto options.
 * @param {string} protoOpts.service - The service git stat.
 * @param {string} protoOpts.method - The method name.
 * @param {number=} protoOpts.timeout - After how many milliseconds should the
 *     request cancel.
 * @param {object} reqOpts - The request options.
 */
GrpcService.prototype.requestStream = function(protoOpts, reqOpts) {
  if (global.GCLOUD_SANDBOX_ENV) {
    return through.obj();
  }

  var self = this;

  if (!protoOpts.stream) {
    protoOpts.stream = through.obj();
  }

  var stream = protoOpts.stream;

  if (!this.grpcCredentials) {
    // We must establish an authClient to give to grpc.
    this.getGrpcCredentials_(function(err, credentials) {
      if (err) {
        stream.destroy(err);
        return;
      }

      self.grpcCredentials = credentials;
      self.requestStream(protoOpts, reqOpts);
    });

    return stream;
  }

  var objectMode = !!reqOpts.objectMode;
  delete reqOpts.objectMode;

  var service = this.getService_(protoOpts);
  var grpcOpts = {};

  if (is.number(protoOpts.timeout)) {
    grpcOpts.deadline = GrpcService.createDeadline_(protoOpts.timeout);
  }

  var retryOpts = {
    retries: this.maxRetries,
    objectMode: objectMode,
    shouldRetryFn: GrpcService.shouldRetryRequest_,

    request: function() {
      return service[protoOpts.method](reqOpts, grpcOpts)
        .on('status', function(status) {
          var grcpStatus = GrpcService.getError_(status);

          this.emit('response', grcpStatus || status);
        });
    }
  };

  return retryRequest(null, retryOpts)
    .on('error', function(err) {
      var grpcError = GrpcService.getError_(err);

      stream.destroy(grpcError || err);
    })
    .pipe(stream);
};

/**
 * Decode a protobuf Struct's value.
 *
 * @private
 *
 * @param {object} value - A Struct's Field message.
 * @return {*} - The decoded value.
 */
GrpcService.decodeValue_ = function(value) {
  switch (value.kind) {
    case 'structValue': {
      return GrpcService.structToObj_(value.structValue);
    }

    case 'nullValue': {
      return null;
    }

    case 'listValue': {
      return value.listValue.values.map(GrpcService.decodeValue_);
    }

    default: {
      return value[value.kind];
    }
  }
};

/**
 * Convert a raw value to a type-denoted protobuf message-friendly object.
 *
 * @private
 *
 * @param {*} value - The input value.
 * @param {object=} options - Configuration object.
 * @param {boolean} options.stringify - Stringify un-recognized types.
 * @return {*} - The encoded value.
 *
 * @example
 * GrpcService.encodeValue_('Hi');
 * // {
 * //   stringValue: 'Hello!'
 * // }
 */
GrpcService.encodeValue_ = function(value, options) {
  options = options || {};

  var convertedValue;

  if (is.null(value)) {
    convertedValue = {
      nullValue: 0
    };
  } else if (is.number(value)) {
    convertedValue = {
      numberValue: value
    };
  } else if (is.string(value)) {
    convertedValue = {
      stringValue: value
    };
  } else if (is.boolean(value)) {
    convertedValue = {
      boolValue: value
    };
  } else if (Buffer.isBuffer(value)) {
    convertedValue = {
      blobValue: value
    };
  } else if (is.object(value)) {
    convertedValue = {
      structValue: GrpcService.objToStruct_(value)
    };
  } else if (is.array(value)) {
    convertedValue = {
      listValue: {
        values: value.map(GrpcService.encodeValue_)
      }
    };
  } else {
    if (!options.stringify) {
      throw new Error('Value of type ' + typeof value + ' not recognized.');
    }

    convertedValue = {
      stringValue: String(value)
    };
  }

  return convertedValue;
};

/**
 * Creates a deadline.
 *
 * @private
 *
 * @param {number} timeout - Timeout in miliseconds.
 * @return {date} deadline - The deadline in Date object form.
 */
GrpcService.createDeadline_ = function(timeout) {
  return new Date(Date.now() + timeout);
};

/**
 * Checks for a grpc error code and extends the Error object with additional
 * information.
 *
 * @private
 *
 * @param {error} err - The original request error.
 * @return {error|null}
 */
GrpcService.getError_ = function(err) {
  if (GRPC_ERROR_CODE_TO_HTTP[err.code]) {
    return extend(true, {}, err, GRPC_ERROR_CODE_TO_HTTP[err.code]);
  }
  return null;
};

/**
 * Function to decide whether or not a request retry could occur.
 *
 * @private
 *
 * @param {object} response - The request response.
 * @return {boolean} shouldRetry
 */
GrpcService.shouldRetryRequest_ = function(response) {
  return [429, 500, 502, 503].indexOf(response.code) > -1;
};

/**
 * Convert an object to a struct.
 *
 * @private
 *
 * @param {object} obj - An object to convert.
 * @param {object=} options - Configuration object.
 * @param {boolean} options.stringify - Stringify un-recognized types.
 * @return {array} - The converted object.
 *
 * @example
 * GrpcService.objToStruct_({
 *   greeting: 'Hello!',
 *   favNumber: 7,
 *   friendIds: [
 *     1004,
 *     1006
 *   ],
 *   userDetails: {
 *     termsSigned: true
 *   }
 * });
 * // {
 * //   fields: {
 * //     greeting: {
 * //       stringValue: 'Hello!'
 * //     },
 * //     favNumber: {
 * //       numberValue: 7
 * //     },
 * //     friendIds: {
 * //       listValue: [
 * //         {
 * //           numberValue: 1004
 * //         },
 * //         {
 * //           numberValue: 1006
 * //         }
 * //       ]
 * //     },
 * //     userDetails: {
 * //       fields: {
 * //         termsSigned: {
 * //           booleanValue: true
 * //         }
 * //       }
 * //     }
 * //   }
 * // }
 */
GrpcService.objToStruct_ = function(obj, options) {
  options = options || {};

  var convertedObject = {
    fields: {}
  };

  for (var prop in obj) {
    if (obj.hasOwnProperty(prop)) {
      var value = obj[prop];

      if (is.undefined(value)) {
        continue;
      }

      convertedObject.fields[prop] = GrpcService.encodeValue_(value, options);
    }
  }

  return convertedObject;
};

/**
 * Condense a protobuf Struct into an object of only its values.
 *
 * @private
 *
 * @param {object} struct - A protobuf Struct message.
 * @return {object} - The simplified object.
 *
 * @example
 * GrpcService.structToObj_({
 *   fields: {
 *     name: {
 *       kind: 'stringValue',
 *       stringValue: 'Stephen'
 *     }
 *   }
 * });
 * // {
 * //   name: 'Stephen'
 * // }
 */
GrpcService.structToObj_ = function(struct) {
  var convertedObject = {};

  for (var prop in struct.fields) {
    if (struct.fields.hasOwnProperty(prop)) {
      var value = struct.fields[prop];
      convertedObject[prop] = GrpcService.decodeValue_(value);
    }
  }

  return convertedObject;
};

/**
 * To authorize requests through gRPC, we must get the raw google-auth-library
 * auth client object.
 *
 * @private
 *
 * @param {function} callback - The callback function.
 * @param {?error} callback.err - An error getting an auth client.
 */
GrpcService.prototype.getGrpcCredentials_ = function(callback) {
  this.authClient.getAuthClient(function(err, authClient) {
    if (err) {
      callback(err);
      return;
    }

    var credentials = grpc.credentials.combineChannelCredentials(
      grpc.credentials.createSsl(),
      grpc.credentials.createFromGoogleCredential(authClient)
    );

    callback(null, credentials);
  });
};

/**
 * Loads a proto file, useful when handling multiple proto files/services
 * within a single instance of GrpcService.
 *
 * @private
 *
 * @param {object} protoConfig - The proto specific configs for this file.
 * @param {object} config - The base config for the GrpcService.
 * @return {object} protoObject - The loaded proto object.
 */
GrpcService.prototype.loadProtoFile_ = function(protoConfig, config) {
  var rootDir = googleProtoFiles('..');

  var grpcOpts = {
    binaryAsBase64: true,
    convertFieldsToCamelCase: true
  };

  if (is.string(protoConfig)) {
    protoConfig = {
      path: protoConfig
    };
  }

  var services = grpc.load({
    root: rootDir,
    file: path.relative(rootDir, protoConfig.path)
  }, 'proto', grpcOpts);

  var serviceName = protoConfig.service || config.service;
  var apiVersion = protoConfig.apiVersion || config.apiVersion;
  var service = dotProp.get(services.google, serviceName);

  return service[apiVersion];
};

/**
 * Retrieves the service object used to make the grpc requests.
 *
 * @private
 *
 * @param {object} protoOpts - The proto options.
 * @return {object} service - The proto service.
 */
GrpcService.prototype.getService_ = function(protoOpts) {
  var proto;

  if (this.protos[protoOpts.service]) {
    proto = this.protos[protoOpts.service];
  } else {
    proto = this.protos[this.service];
  }

  var service = this.activeServiceMap_.get(protoOpts.service);

  if (!service) {
    service = new proto[protoOpts.service](
      this.baseUrl,
      this.grpcCredentials
    );

    this.activeServiceMap_.set(protoOpts.service, service);
  }

  return service;
};

module.exports = GrpcService;
module.exports.GRPC_ERROR_CODE_TO_HTTP = GRPC_ERROR_CODE_TO_HTTP;
