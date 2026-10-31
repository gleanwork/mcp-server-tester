# Architecture

Written for release 2.0. Some numbers here are out of date: the settings a
deployment uses are in `config/service.json`.

A producer posts a message to the ingest module. Ingest checks the payload
(at most 256 KB) and writes it to the queue. Eight workers take messages from
the queue, highest priority first. A message stays in the queue for 14 days.

The scheduler module wakes delayed messages when their time comes. The auth
module checks each producer's token.
