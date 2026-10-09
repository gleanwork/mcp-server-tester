import { describe, expect, it } from 'vitest';
import { createLimiter, trialResources } from './limiter.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('createLimiter', () => {
  it('holds a trial back until a capped resource has room', async () => {
    const limiter = createLimiter({ providers: { anthropic: 1 } });
    const first = await limiter.acquire(['provider:anthropic']);
    let second = false;
    void limiter.acquire(['provider:anthropic']).then(() => (second = true));
    await tick();
    expect(second).toBe(false);
    first();
    await tick();
    expect(second).toBe(true);
  });

  it('caps each resource on its own, and leaves uncapped ones alone', async () => {
    const limiter = createLimiter({
      providers: { anthropic: 2 },
      servers: { slack: 1 },
    });
    await limiter.acquire(['provider:anthropic', 'server:slack']);
    // Room for the provider, none for slack.
    let slack = false;
    void limiter
      .acquire(['provider:anthropic', 'server:slack'])
      .then(() => (slack = true));
    // Neither capped resource here is full.
    await limiter.acquire(['provider:anthropic', 'server:github']);
    await limiter.acquire(['provider:openai']);
    await tick();
    expect(slack).toBe(false);
  });

  it('lets a waiter that fits go ahead of one that does not', async () => {
    const limiter = createLimiter({ servers: { slack: 1, jira: 1 } });
    const slack = await limiter.acquire(['server:slack']);
    const jira = await limiter.acquire(['server:jira']);
    const order: string[] = [];
    void limiter
      .acquire(['server:slack', 'server:jira'])
      .then(() => order.push('both'));
    void limiter.acquire(['server:jira']).then(() => order.push('jira'));
    jira();
    await tick();
    expect(order).toEqual(['jira']);
    slack();
    await tick();
    expect(order).toEqual(['jira']);
  });

  it('never waits without limits', async () => {
    const limiter = createLimiter(undefined);
    await Promise.all(
      Array.from({ length: 5 }, () => limiter.acquire(['provider:anthropic']))
    );
  });
});

describe('trialResources', () => {
  it("names the model's provider and the servers' labels", () => {
    expect(
      trialResources('claude-opus-4-8', [
        { transport: 'http', label: 'slack', serverUrl: 'https://s.example' },
      ])
    ).toEqual(['provider:anthropic', 'server:slack']);
    expect(trialResources(undefined, [])).toEqual([]);
  });
});
