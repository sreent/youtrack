/** Wires AI features into the server: the triage consumer runs in the outbox worker. */
import { consumerFactories } from '../server';
import { triageConsumer } from './triage';

consumerFactories.push(triageConsumer);
