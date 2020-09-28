import { Callback, maybePromise, MongoDBNamespace } from '../utils';
import { Long, Document, BSONSerializeOptions } from '../bson';
import { ClientSession } from '../sessions';
import { MongoError } from '../error';
import Denque = require('denque');
import type { Server } from '../sdam/server';
import type { CursorCloseOptions } from './core_cursor';
import type { Topology } from '../sdam/topology';

const kId = Symbol('id');
const kDocuments = Symbol('documents');
const kServer = Symbol('server');
const kSession = Symbol('session');
const kNamespace = Symbol('namespace');
const kTopology = Symbol('topology');

export interface AbstractCursorOptions extends BSONSerializeOptions {
  session?: ClientSession;
}

export abstract class AbstractCursor {
  [kServer]?: Server;
  [kId]?: Long;
  [kNamespace]: MongoDBNamespace;
  [kDocuments]: Denque<Document>;
  [kSession]?: ClientSession;
  [kTopology]: Topology;

  constructor(topology: Topology, ns: MongoDBNamespace, options: AbstractCursorOptions = {}) {
    this[kTopology] = topology;
    this[kNamespace] = ns;
    this[kDocuments] = new Denque();

    if (options.session instanceof ClientSession) {
      this[kSession] = options.session;
    }
  }

  get id(): Long | undefined {
    return this[kId];
  }

  get topology(): Topology {
    return this[kTopology];
  }

  get namespace(): MongoDBNamespace {
    return this[kNamespace];
  }

  hasNext(): Promise<boolean>;
  hasNext(callback: Callback<boolean>): void;
  hasNext(callback?: Callback<boolean>): Promise<boolean> | void {
    return maybePromise(callback, done => {
      if (this[kId] === Long.ZERO) {
        return done(undefined, false);
      }

      if (this[kDocuments].length) {
        return done(undefined, true);
      }

      next(this, (err, doc) => {
        if (err) return done(err);

        if (doc) {
          this[kDocuments].unshift(doc);
          done(undefined, true);
          return;
        }

        done(undefined, false);
      });
    });
  }

  /** Get the next available document from the cursor, returns null if no more documents are available. */
  next(): Promise<Document | null>;
  next(callback: Callback<Document | null>): void;
  next(callback?: Callback<Document | null>): Promise<Document | null> | void {
    return maybePromise(callback, done => {
      if (this[kId] === Long.ZERO) {
        return done(new MongoError('Cursor is exhausted'));
      }

      next(this, done);
    });
  }

  close(): void;
  close(callback: Callback): void;
  close(options: CursorCloseOptions): Promise<void>;
  close(options: CursorCloseOptions, callback: Callback): void;
  close(options?: CursorCloseOptions | Callback, callback?: Callback): Promise<void> | void {
    if (typeof options === 'function') (callback = options), (options = {});
    options = options || {};

    return maybePromise(callback, done => {
      done();
    });
  }

  /**
   * Returns an array of documents. The caller is responsible for making sure that there
   * is enough memory to store the results. Note that the array only contains partial
   * results when this cursor had been previously accessed. In that case,
   * cursor.rewind() can be used to reset the cursor.
   *
   * @param callback - The result callback.
   */
  toArray(): Promise<Document[]>;
  toArray(callback: Callback<Document[]>): void;
  toArray(callback?: Callback<Document[]>): Promise<Document[]> | void {
    return maybePromise(callback, done => {
      const docs: Document[] = [];
      const fetchDocs = () => {
        next(this, (err, doc) => {
          if (err) return done(err);
          if (doc == null) return done(undefined, docs);

          docs.push(doc);
          const internalDocs = this[kDocuments].splice(0, this[kDocuments].length);
          if (internalDocs) {
            docs.push(...internalDocs);
          }

          fetchDocs();
        });
      };

      fetchDocs();
    });
  }

  /* @internal */
  abstract _initialize(server: Server, callback: Callback<Document>): void;
}

function next(cursor: AbstractCursor, callback: Callback<Document | null>): void {
  const cursorId = cursor[kId];
  const cursorNs = cursor[kNamespace];
  const topology = cursor[kTopology];
  const server = cursor[kServer];

  if (cursorId == null) {
    topology.selectServer('primary', (err, server) => {
      if (err || !server) return callback(err);
      cursor[kServer] = server;
      // TODO: session

      cursor._initialize(server, (err, response) => {
        if (response) {
          const cursorId =
            typeof response.cursor.id === 'number'
              ? Long.fromNumber(response.cursor.id)
              : response.cursor.id;

          cursor[kDocuments] = response.cursor.firstBatch;
          cursor[kId] = cursorId;
        }

        if (err || (cursor.id && cursor.id.isZero())) {
          callback(err, cursor[kDocuments].length ? cursor[kDocuments].shift() : null);
          // this._endSession(() => callback(err, null));
          return;
        }

        callback(err, cursor[kDocuments].length ? cursor[kDocuments].shift() : null);
      });
    });

    return;
  }

  if (cursor[kDocuments].length) {
    callback(undefined, cursor[kDocuments].shift());
    return;
  }

  if (cursorId.isZero()) {
    callback(undefined, null);
    return;
  }

  // otherwise need to call getMore
  if (server == null) {
    callback(new MongoError('unable to iterate cursor without pinned server'));
    return;
  }

  server.getMore(cursorNs.toString(), cursorId, { session: cursor[kSession] }, (err, response) => {
    if (response) {
      const cursorId =
        typeof response.cursor.id === 'number'
          ? Long.fromNumber(response.cursor.id)
          : response.cursor.id;

      cursor[kDocuments] = response.cursor.nextBatch;
      cursor[kId] = cursorId;
    }

    if (err || (cursor.id && cursor.id.isZero())) {
      callback(err, cursor[kDocuments].length ? cursor[kDocuments].shift() : null);
      // this._endSession(() => callback(err, null));
      return;
    }

    callback(err, cursor[kDocuments].length ? cursor[kDocuments].shift() : null);
  });
}
