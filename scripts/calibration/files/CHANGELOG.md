# Changelog

## 3.4.0 (2026-03-02)

- Messages that fail five times go to a dead-letter queue.

## 3.3.0 (2026-01-15)

- Payloads over 64 KB are compressed.

## 3.2.1 (2025-12-03)

- Fixed a retry storm when the queue was full.

## 3.0.0 (2025-09-22)

- Dropped support for Node 18.
- Raised the payload limit to 512 KB.
