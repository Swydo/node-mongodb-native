"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BinMsg = exports.Msg = exports.Response = exports.KillCursor = exports.GetMore = exports.Query = void 0;
const read_preference_1 = require("../read_preference");
const BSON = require("../bson");
const utils_1 = require("../utils");
const constants_1 = require("./wire_protocol/constants");
const error_1 = require("../error");
// Incrementing request id
let _requestId = 0;
// Query flags
const OPTS_TAILABLE_CURSOR = 2;
const OPTS_SLAVE = 4;
const OPTS_OPLOG_REPLAY = 8;
const OPTS_NO_CURSOR_TIMEOUT = 16;
const OPTS_AWAIT_DATA = 32;
const OPTS_EXHAUST = 64;
const OPTS_PARTIAL = 128;
// Response flags
const CURSOR_NOT_FOUND = 1;
const QUERY_FAILURE = 2;
const SHARD_CONFIG_STALE = 4;
const AWAIT_CAPABLE = 8;
/**************************************************************
 * QUERY
 **************************************************************/
/** @internal */
class Query {
    constructor(ns, query, options) {
        // Basic options needed to be passed in
        if (ns == null)
            throw new error_1.MongoDriverError('ns must be specified for query');
        if (query == null)
            throw new error_1.MongoDriverError('query must be specified for query');
        // Validate that we are not passing 0x00 in the collection name
        if (ns.indexOf('\x00') !== -1) {
            throw new error_1.MongoDriverError('namespace cannot contain a null character');
        }
        // Basic options
        this.ns = ns;
        this.query = query;
        // Additional options
        this.numberToSkip = options.numberToSkip || 0;
        this.numberToReturn = options.numberToReturn || 0;
        this.returnFieldSelector = options.returnFieldSelector || undefined;
        this.requestId = Query.getRequestId();
        // special case for pre-3.2 find commands, delete ASAP
        this.pre32Limit = options.pre32Limit;
        // Serialization option
        this.serializeFunctions =
            typeof options.serializeFunctions === 'boolean' ? options.serializeFunctions : false;
        this.ignoreUndefined =
            typeof options.ignoreUndefined === 'boolean' ? options.ignoreUndefined : false;
        this.maxBsonSize = options.maxBsonSize || 1024 * 1024 * 16;
        this.checkKeys = typeof options.checkKeys === 'boolean' ? options.checkKeys : false;
        this.batchSize = this.numberToReturn;
        // Flags
        this.tailable = false;
        this.slaveOk = typeof options.slaveOk === 'boolean' ? options.slaveOk : false;
        this.oplogReplay = false;
        this.noCursorTimeout = false;
        this.awaitData = false;
        this.exhaust = false;
        this.partial = false;
    }
    /** Assign next request Id. */
    incRequestId() {
        this.requestId = _requestId++;
    }
    /** Peek next request Id. */
    nextRequestId() {
        return _requestId + 1;
    }
    /** Increment then return next request Id. */
    static getRequestId() {
        return ++_requestId;
    }
    // Uses a single allocated buffer for the process, avoiding multiple memory allocations
    toBin() {
        const buffers = [];
        let projection = null;
        // Set up the flags
        let flags = 0;
        if (this.tailable) {
            flags |= OPTS_TAILABLE_CURSOR;
        }
        if (this.slaveOk) {
            flags |= OPTS_SLAVE;
        }
        if (this.oplogReplay) {
            flags |= OPTS_OPLOG_REPLAY;
        }
        if (this.noCursorTimeout) {
            flags |= OPTS_NO_CURSOR_TIMEOUT;
        }
        if (this.awaitData) {
            flags |= OPTS_AWAIT_DATA;
        }
        if (this.exhaust) {
            flags |= OPTS_EXHAUST;
        }
        if (this.partial) {
            flags |= OPTS_PARTIAL;
        }
        // If batchSize is different to this.numberToReturn
        if (this.batchSize !== this.numberToReturn)
            this.numberToReturn = this.batchSize;
        // Allocate write protocol header buffer
        const header = Buffer.alloc(4 * 4 + // Header
            4 + // Flags
            Buffer.byteLength(this.ns) +
            1 + // namespace
            4 + // numberToSkip
            4 // numberToReturn
        );
        // Add header to buffers
        buffers.push(header);
        // Serialize the query
        const query = BSON.serialize(this.query, {
            checkKeys: this.checkKeys,
            serializeFunctions: this.serializeFunctions,
            ignoreUndefined: this.ignoreUndefined
        });
        // Add query document
        buffers.push(query);
        if (this.returnFieldSelector && Object.keys(this.returnFieldSelector).length > 0) {
            // Serialize the projection document
            projection = BSON.serialize(this.returnFieldSelector, {
                checkKeys: this.checkKeys,
                serializeFunctions: this.serializeFunctions,
                ignoreUndefined: this.ignoreUndefined
            });
            // Add projection document
            buffers.push(projection);
        }
        // Total message size
        const totalLength = header.length + query.length + (projection ? projection.length : 0);
        // Set up the index
        let index = 4;
        // Write total document length
        header[3] = (totalLength >> 24) & 0xff;
        header[2] = (totalLength >> 16) & 0xff;
        header[1] = (totalLength >> 8) & 0xff;
        header[0] = totalLength & 0xff;
        // Write header information requestId
        header[index + 3] = (this.requestId >> 24) & 0xff;
        header[index + 2] = (this.requestId >> 16) & 0xff;
        header[index + 1] = (this.requestId >> 8) & 0xff;
        header[index] = this.requestId & 0xff;
        index = index + 4;
        // Write header information responseTo
        header[index + 3] = (0 >> 24) & 0xff;
        header[index + 2] = (0 >> 16) & 0xff;
        header[index + 1] = (0 >> 8) & 0xff;
        header[index] = 0 & 0xff;
        index = index + 4;
        // Write header information OP_QUERY
        header[index + 3] = (constants_1.OP_QUERY >> 24) & 0xff;
        header[index + 2] = (constants_1.OP_QUERY >> 16) & 0xff;
        header[index + 1] = (constants_1.OP_QUERY >> 8) & 0xff;
        header[index] = constants_1.OP_QUERY & 0xff;
        index = index + 4;
        // Write header information flags
        header[index + 3] = (flags >> 24) & 0xff;
        header[index + 2] = (flags >> 16) & 0xff;
        header[index + 1] = (flags >> 8) & 0xff;
        header[index] = flags & 0xff;
        index = index + 4;
        // Write collection name
        index = index + header.write(this.ns, index, 'utf8') + 1;
        header[index - 1] = 0;
        // Write header information flags numberToSkip
        header[index + 3] = (this.numberToSkip >> 24) & 0xff;
        header[index + 2] = (this.numberToSkip >> 16) & 0xff;
        header[index + 1] = (this.numberToSkip >> 8) & 0xff;
        header[index] = this.numberToSkip & 0xff;
        index = index + 4;
        // Write header information flags numberToReturn
        header[index + 3] = (this.numberToReturn >> 24) & 0xff;
        header[index + 2] = (this.numberToReturn >> 16) & 0xff;
        header[index + 1] = (this.numberToReturn >> 8) & 0xff;
        header[index] = this.numberToReturn & 0xff;
        index = index + 4;
        // Return the buffers
        return buffers;
    }
}
exports.Query = Query;
/**************************************************************
 * GETMORE
 **************************************************************/
/** @internal */
class GetMore {
    constructor(ns, cursorId, opts = {}) {
        this.numberToReturn = opts.numberToReturn || 0;
        this.requestId = _requestId++;
        this.ns = ns;
        this.cursorId = cursorId;
    }
    // Uses a single allocated buffer for the process, avoiding multiple memory allocations
    toBin() {
        const length = 4 + Buffer.byteLength(this.ns) + 1 + 4 + 8 + 4 * 4;
        // Create command buffer
        let index = 0;
        // Allocate buffer
        const _buffer = Buffer.alloc(length);
        // Write header information
        // index = write32bit(index, _buffer, length);
        _buffer[index + 3] = (length >> 24) & 0xff;
        _buffer[index + 2] = (length >> 16) & 0xff;
        _buffer[index + 1] = (length >> 8) & 0xff;
        _buffer[index] = length & 0xff;
        index = index + 4;
        // index = write32bit(index, _buffer, requestId);
        _buffer[index + 3] = (this.requestId >> 24) & 0xff;
        _buffer[index + 2] = (this.requestId >> 16) & 0xff;
        _buffer[index + 1] = (this.requestId >> 8) & 0xff;
        _buffer[index] = this.requestId & 0xff;
        index = index + 4;
        // index = write32bit(index, _buffer, 0);
        _buffer[index + 3] = (0 >> 24) & 0xff;
        _buffer[index + 2] = (0 >> 16) & 0xff;
        _buffer[index + 1] = (0 >> 8) & 0xff;
        _buffer[index] = 0 & 0xff;
        index = index + 4;
        // index = write32bit(index, _buffer, OP_GETMORE);
        _buffer[index + 3] = (constants_1.OP_GETMORE >> 24) & 0xff;
        _buffer[index + 2] = (constants_1.OP_GETMORE >> 16) & 0xff;
        _buffer[index + 1] = (constants_1.OP_GETMORE >> 8) & 0xff;
        _buffer[index] = constants_1.OP_GETMORE & 0xff;
        index = index + 4;
        // index = write32bit(index, _buffer, 0);
        _buffer[index + 3] = (0 >> 24) & 0xff;
        _buffer[index + 2] = (0 >> 16) & 0xff;
        _buffer[index + 1] = (0 >> 8) & 0xff;
        _buffer[index] = 0 & 0xff;
        index = index + 4;
        // Write collection name
        index = index + _buffer.write(this.ns, index, 'utf8') + 1;
        _buffer[index - 1] = 0;
        // Write batch size
        // index = write32bit(index, _buffer, numberToReturn);
        _buffer[index + 3] = (this.numberToReturn >> 24) & 0xff;
        _buffer[index + 2] = (this.numberToReturn >> 16) & 0xff;
        _buffer[index + 1] = (this.numberToReturn >> 8) & 0xff;
        _buffer[index] = this.numberToReturn & 0xff;
        index = index + 4;
        // Write cursor id
        // index = write32bit(index, _buffer, cursorId.getLowBits());
        _buffer[index + 3] = (this.cursorId.getLowBits() >> 24) & 0xff;
        _buffer[index + 2] = (this.cursorId.getLowBits() >> 16) & 0xff;
        _buffer[index + 1] = (this.cursorId.getLowBits() >> 8) & 0xff;
        _buffer[index] = this.cursorId.getLowBits() & 0xff;
        index = index + 4;
        // index = write32bit(index, _buffer, cursorId.getHighBits());
        _buffer[index + 3] = (this.cursorId.getHighBits() >> 24) & 0xff;
        _buffer[index + 2] = (this.cursorId.getHighBits() >> 16) & 0xff;
        _buffer[index + 1] = (this.cursorId.getHighBits() >> 8) & 0xff;
        _buffer[index] = this.cursorId.getHighBits() & 0xff;
        index = index + 4;
        // Return buffer
        return [_buffer];
    }
}
exports.GetMore = GetMore;
/**************************************************************
 * KILLCURSOR
 **************************************************************/
/** @internal */
class KillCursor {
    constructor(ns, cursorIds) {
        this.ns = ns;
        this.requestId = _requestId++;
        this.cursorIds = cursorIds;
    }
    // Uses a single allocated buffer for the process, avoiding multiple memory allocations
    toBin() {
        const length = 4 + 4 + 4 * 4 + this.cursorIds.length * 8;
        // Create command buffer
        let index = 0;
        const _buffer = Buffer.alloc(length);
        // Write header information
        // index = write32bit(index, _buffer, length);
        _buffer[index + 3] = (length >> 24) & 0xff;
        _buffer[index + 2] = (length >> 16) & 0xff;
        _buffer[index + 1] = (length >> 8) & 0xff;
        _buffer[index] = length & 0xff;
        index = index + 4;
        // index = write32bit(index, _buffer, requestId);
        _buffer[index + 3] = (this.requestId >> 24) & 0xff;
        _buffer[index + 2] = (this.requestId >> 16) & 0xff;
        _buffer[index + 1] = (this.requestId >> 8) & 0xff;
        _buffer[index] = this.requestId & 0xff;
        index = index + 4;
        // index = write32bit(index, _buffer, 0);
        _buffer[index + 3] = (0 >> 24) & 0xff;
        _buffer[index + 2] = (0 >> 16) & 0xff;
        _buffer[index + 1] = (0 >> 8) & 0xff;
        _buffer[index] = 0 & 0xff;
        index = index + 4;
        // index = write32bit(index, _buffer, OP_KILL_CURSORS);
        _buffer[index + 3] = (constants_1.OP_KILL_CURSORS >> 24) & 0xff;
        _buffer[index + 2] = (constants_1.OP_KILL_CURSORS >> 16) & 0xff;
        _buffer[index + 1] = (constants_1.OP_KILL_CURSORS >> 8) & 0xff;
        _buffer[index] = constants_1.OP_KILL_CURSORS & 0xff;
        index = index + 4;
        // index = write32bit(index, _buffer, 0);
        _buffer[index + 3] = (0 >> 24) & 0xff;
        _buffer[index + 2] = (0 >> 16) & 0xff;
        _buffer[index + 1] = (0 >> 8) & 0xff;
        _buffer[index] = 0 & 0xff;
        index = index + 4;
        // Write batch size
        // index = write32bit(index, _buffer, this.cursorIds.length);
        _buffer[index + 3] = (this.cursorIds.length >> 24) & 0xff;
        _buffer[index + 2] = (this.cursorIds.length >> 16) & 0xff;
        _buffer[index + 1] = (this.cursorIds.length >> 8) & 0xff;
        _buffer[index] = this.cursorIds.length & 0xff;
        index = index + 4;
        // Write all the cursor ids into the array
        for (let i = 0; i < this.cursorIds.length; i++) {
            // Write cursor id
            // index = write32bit(index, _buffer, cursorIds[i].getLowBits());
            _buffer[index + 3] = (this.cursorIds[i].getLowBits() >> 24) & 0xff;
            _buffer[index + 2] = (this.cursorIds[i].getLowBits() >> 16) & 0xff;
            _buffer[index + 1] = (this.cursorIds[i].getLowBits() >> 8) & 0xff;
            _buffer[index] = this.cursorIds[i].getLowBits() & 0xff;
            index = index + 4;
            // index = write32bit(index, _buffer, cursorIds[i].getHighBits());
            _buffer[index + 3] = (this.cursorIds[i].getHighBits() >> 24) & 0xff;
            _buffer[index + 2] = (this.cursorIds[i].getHighBits() >> 16) & 0xff;
            _buffer[index + 1] = (this.cursorIds[i].getHighBits() >> 8) & 0xff;
            _buffer[index] = this.cursorIds[i].getHighBits() & 0xff;
            index = index + 4;
        }
        // Return buffer
        return [_buffer];
    }
}
exports.KillCursor = KillCursor;
/** @internal */
class Response {
    constructor(message, msgHeader, msgBody, opts) {
        this.parsed = false;
        this.raw = message;
        this.data = msgBody;
        this.opts = opts !== null && opts !== void 0 ? opts : {
            promoteLongs: true,
            promoteValues: true,
            promoteBuffers: false,
            bsonRegExp: false
        };
        // Read the message header
        this.length = msgHeader.length;
        this.requestId = msgHeader.requestId;
        this.responseTo = msgHeader.responseTo;
        this.opCode = msgHeader.opCode;
        this.fromCompressed = msgHeader.fromCompressed;
        // Read the message body
        this.responseFlags = msgBody.readInt32LE(0);
        this.cursorId = new BSON.Long(msgBody.readInt32LE(4), msgBody.readInt32LE(8));
        this.startingFrom = msgBody.readInt32LE(12);
        this.numberReturned = msgBody.readInt32LE(16);
        // Preallocate document array
        this.documents = new Array(this.numberReturned);
        // Flag values
        this.cursorNotFound = (this.responseFlags & CURSOR_NOT_FOUND) !== 0;
        this.queryFailure = (this.responseFlags & QUERY_FAILURE) !== 0;
        this.shardConfigStale = (this.responseFlags & SHARD_CONFIG_STALE) !== 0;
        this.awaitCapable = (this.responseFlags & AWAIT_CAPABLE) !== 0;
        this.promoteLongs = typeof this.opts.promoteLongs === 'boolean' ? this.opts.promoteLongs : true;
        this.promoteValues =
            typeof this.opts.promoteValues === 'boolean' ? this.opts.promoteValues : true;
        this.promoteBuffers =
            typeof this.opts.promoteBuffers === 'boolean' ? this.opts.promoteBuffers : false;
        this.bsonRegExp = typeof this.opts.bsonRegExp === 'boolean' ? this.opts.bsonRegExp : false;
    }
    isParsed() {
        return this.parsed;
    }
    parse(options) {
        var _a, _b, _c, _d;
        // Don't parse again if not needed
        if (this.parsed)
            return;
        options = options !== null && options !== void 0 ? options : {};
        // Allow the return of raw documents instead of parsing
        const raw = options.raw || false;
        const documentsReturnedIn = options.documentsReturnedIn || null;
        const promoteLongs = (_a = options.promoteLongs) !== null && _a !== void 0 ? _a : this.opts.promoteLongs;
        const promoteValues = (_b = options.promoteValues) !== null && _b !== void 0 ? _b : this.opts.promoteValues;
        const promoteBuffers = (_c = options.promoteBuffers) !== null && _c !== void 0 ? _c : this.opts.promoteBuffers;
        const bsonRegExp = (_d = options.bsonRegExp) !== null && _d !== void 0 ? _d : this.opts.bsonRegExp;
        let bsonSize;
        // Set up the options
        const _options = {
            promoteLongs,
            promoteValues,
            promoteBuffers,
            bsonRegExp
        };
        // Position within OP_REPLY at which documents start
        // (See https://docs.mongodb.com/manual/reference/mongodb-wire-protocol/#wire-op-reply)
        this.index = 20;
        // Parse Body
        for (let i = 0; i < this.numberReturned; i++) {
            bsonSize =
                this.data[this.index] |
                    (this.data[this.index + 1] << 8) |
                    (this.data[this.index + 2] << 16) |
                    (this.data[this.index + 3] << 24);
            // If we have raw results specified slice the return document
            if (raw) {
                this.documents[i] = this.data.slice(this.index, this.index + bsonSize);
            }
            else {
                this.documents[i] = BSON.deserialize(this.data.slice(this.index, this.index + bsonSize), _options);
            }
            // Adjust the index
            this.index = this.index + bsonSize;
        }
        if (this.documents.length === 1 && documentsReturnedIn != null && raw) {
            const fieldsAsRaw = {};
            fieldsAsRaw[documentsReturnedIn] = true;
            _options.fieldsAsRaw = fieldsAsRaw;
            const doc = BSON.deserialize(this.documents[0], _options);
            this.documents = [doc];
        }
        // Set parsed
        this.parsed = true;
    }
}
exports.Response = Response;
// Implementation of OP_MSG spec:
// https://github.com/mongodb/specifications/blob/master/source/message/OP_MSG.rst
//
// struct Section {
//   uint8 payloadType;
//   union payload {
//       document  document; // payloadType == 0
//       struct sequence { // payloadType == 1
//           int32      size;
//           cstring    identifier;
//           document*  documents;
//       };
//   };
// };
// struct OP_MSG {
//   struct MsgHeader {
//       int32  messageLength;
//       int32  requestID;
//       int32  responseTo;
//       int32  opCode = 2013;
//   };
//   uint32      flagBits;
//   Section+    sections;
//   [uint32     checksum;]
// };
// Msg Flags
const OPTS_CHECKSUM_PRESENT = 1;
const OPTS_MORE_TO_COME = 2;
const OPTS_EXHAUST_ALLOWED = 1 << 16;
/** @internal */
class Msg {
    constructor(ns, command, options) {
        // Basic options needed to be passed in
        if (command == null)
            throw new error_1.MongoDriverError('query must be specified for query');
        // Basic options
        this.ns = ns;
        this.command = command;
        this.command.$db = utils_1.databaseNamespace(ns);
        if (options.readPreference && options.readPreference.mode !== read_preference_1.ReadPreference.PRIMARY) {
            this.command.$readPreference = options.readPreference.toJSON();
        }
        // Ensure empty options
        this.options = options !== null && options !== void 0 ? options : {};
        // Additional options
        this.requestId = options.requestId ? options.requestId : Msg.getRequestId();
        // Serialization option
        this.serializeFunctions =
            typeof options.serializeFunctions === 'boolean' ? options.serializeFunctions : false;
        this.ignoreUndefined =
            typeof options.ignoreUndefined === 'boolean' ? options.ignoreUndefined : false;
        this.checkKeys = typeof options.checkKeys === 'boolean' ? options.checkKeys : false;
        this.maxBsonSize = options.maxBsonSize || 1024 * 1024 * 16;
        // flags
        this.checksumPresent = false;
        this.moreToCome = options.moreToCome || false;
        this.exhaustAllowed =
            typeof options.exhaustAllowed === 'boolean' ? options.exhaustAllowed : false;
    }
    toBin() {
        const buffers = [];
        let flags = 0;
        if (this.checksumPresent) {
            flags |= OPTS_CHECKSUM_PRESENT;
        }
        if (this.moreToCome) {
            flags |= OPTS_MORE_TO_COME;
        }
        if (this.exhaustAllowed) {
            flags |= OPTS_EXHAUST_ALLOWED;
        }
        const header = Buffer.alloc(4 * 4 + // Header
            4 // Flags
        );
        buffers.push(header);
        let totalLength = header.length;
        const command = this.command;
        totalLength += this.makeDocumentSegment(buffers, command);
        header.writeInt32LE(totalLength, 0); // messageLength
        header.writeInt32LE(this.requestId, 4); // requestID
        header.writeInt32LE(0, 8); // responseTo
        header.writeInt32LE(constants_1.OP_MSG, 12); // opCode
        header.writeUInt32LE(flags, 16); // flags
        return buffers;
    }
    makeDocumentSegment(buffers, document) {
        const payloadTypeBuffer = Buffer.alloc(1);
        payloadTypeBuffer[0] = 0;
        const documentBuffer = this.serializeBson(document);
        buffers.push(payloadTypeBuffer);
        buffers.push(documentBuffer);
        return payloadTypeBuffer.length + documentBuffer.length;
    }
    serializeBson(document) {
        return BSON.serialize(document, {
            checkKeys: this.checkKeys,
            serializeFunctions: this.serializeFunctions,
            ignoreUndefined: this.ignoreUndefined
        });
    }
    static getRequestId() {
        _requestId = (_requestId + 1) & 0x7fffffff;
        return _requestId;
    }
}
exports.Msg = Msg;
/** @internal */
class BinMsg {
    constructor(message, msgHeader, msgBody, opts) {
        this.parsed = false;
        this.raw = message;
        this.data = msgBody;
        this.opts = opts !== null && opts !== void 0 ? opts : {
            promoteLongs: true,
            promoteValues: true,
            promoteBuffers: false,
            bsonRegExp: false
        };
        // Read the message header
        this.length = msgHeader.length;
        this.requestId = msgHeader.requestId;
        this.responseTo = msgHeader.responseTo;
        this.opCode = msgHeader.opCode;
        this.fromCompressed = msgHeader.fromCompressed;
        // Read response flags
        this.responseFlags = msgBody.readInt32LE(0);
        this.checksumPresent = (this.responseFlags & OPTS_CHECKSUM_PRESENT) !== 0;
        this.moreToCome = (this.responseFlags & OPTS_MORE_TO_COME) !== 0;
        this.exhaustAllowed = (this.responseFlags & OPTS_EXHAUST_ALLOWED) !== 0;
        this.promoteLongs = typeof this.opts.promoteLongs === 'boolean' ? this.opts.promoteLongs : true;
        this.promoteValues =
            typeof this.opts.promoteValues === 'boolean' ? this.opts.promoteValues : true;
        this.promoteBuffers =
            typeof this.opts.promoteBuffers === 'boolean' ? this.opts.promoteBuffers : false;
        this.bsonRegExp = typeof this.opts.bsonRegExp === 'boolean' ? this.opts.bsonRegExp : false;
        this.documents = [];
    }
    isParsed() {
        return this.parsed;
    }
    parse(options) {
        var _a, _b, _c, _d;
        // Don't parse again if not needed
        if (this.parsed)
            return;
        options = options !== null && options !== void 0 ? options : {};
        this.index = 4;
        // Allow the return of raw documents instead of parsing
        const raw = options.raw || false;
        const documentsReturnedIn = options.documentsReturnedIn || null;
        const promoteLongs = (_a = options.promoteLongs) !== null && _a !== void 0 ? _a : this.opts.promoteLongs;
        const promoteValues = (_b = options.promoteValues) !== null && _b !== void 0 ? _b : this.opts.promoteValues;
        const promoteBuffers = (_c = options.promoteBuffers) !== null && _c !== void 0 ? _c : this.opts.promoteBuffers;
        const bsonRegExp = (_d = options.bsonRegExp) !== null && _d !== void 0 ? _d : this.opts.bsonRegExp;
        // Set up the options
        const _options = {
            promoteLongs,
            promoteValues,
            promoteBuffers,
            bsonRegExp
        };
        while (this.index < this.data.length) {
            const payloadType = this.data.readUInt8(this.index++);
            if (payloadType === 0) {
                const bsonSize = this.data.readUInt32LE(this.index);
                const bin = this.data.slice(this.index, this.index + bsonSize);
                this.documents.push(raw ? bin : BSON.deserialize(bin, _options));
                this.index += bsonSize;
            }
            else if (payloadType === 1) {
                // It was decided that no driver makes use of payload type 1
                throw new error_1.MongoDriverError('OP_MSG Payload Type 1 detected unsupported protocol');
            }
        }
        if (this.documents.length === 1 && documentsReturnedIn != null && raw) {
            const fieldsAsRaw = {};
            fieldsAsRaw[documentsReturnedIn] = true;
            _options.fieldsAsRaw = fieldsAsRaw;
            const doc = BSON.deserialize(this.documents[0], _options);
            this.documents = [doc];
        }
        this.parsed = true;
    }
}
exports.BinMsg = BinMsg;
//# sourceMappingURL=commands.js.map