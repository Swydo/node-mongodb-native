import type { Document } from '../bson';
import { executeOperation } from '../operations/execute_operation';
import { FindOperation, FindOptions } from '../operations/find';
import type { Server } from '../sdam/server';
import type { Topology } from '../sdam/topology';
import type { Callback, MongoDBNamespace } from '../utils';
import { AbstractCursor } from './abstract_cursor';

export class FindCursor extends AbstractCursor {
  filter: Document;
  options: FindOptions;

  constructor(
    topology: Topology,
    ns: MongoDBNamespace,
    filter: Document | undefined,
    options: FindOptions
  ) {
    super(topology, ns);

    this.filter = filter || {};
    this.options = options;
  }

  _initialize(server: Server, callback: Callback<Document>): void {
    const operation = new FindOperation(undefined, this.namespace, this.filter, this.options);
    operation.execute(server, callback);
  }
}
