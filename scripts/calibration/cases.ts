/**
 * The calibration set's cases. Each one is a trace whose right label is
 * known from how it was built: a scripted client (./plugin.mjs) makes real
 * tool calls against MST's mock server and the filesystem reference server
 * (over ./files), then gives an answer written to be right or wrong in one
 * way. No person reviewed these labels; docs/judges.md says so.
 *
 * Each template is a task with its right call, a wrong call and a failing
 * call. Each trace kind combines them into one trace, and `LABELS` gives the
 * label it has for each judge question.
 */

/** A tool call the scripted client makes. `{files}` in an argument is the fixture folder. */
interface ScriptedCall {
  server: 'mock' | 'files';
  tool: string;
  args: Record<string, unknown>;
}

interface Template {
  id: string;
  input: string;
  /** The reference answer judges compare against. */
  reference: string;
  /** The call that answers the task. */
  call: ScriptedCall;
  /** The answer the right call's result supports. */
  answer: string;
  /** An answer that contradicts the right call's result. */
  wrongAnswer: string;
  /** A claim no tool result supports, added to the right answer. */
  extraClaim: string;
  /** A plausible wrong tool, or the right tool with wrong arguments. */
  wrongCall: ScriptedCall;
  /** An answer true to the wrong call's result, which doesn't do the task. */
  wrongCallAnswer: string;
  /** A call that returns an error (a wrong path or an invalid argument). */
  failingCall: ScriptedCall;
  /** Calls that find the way after the failing call, before the right one. */
  recovery: ScriptedCall[];
  /** An answer that reports the failing call's error and stops. */
  gaveUpAnswer: string;
  /** Calls the task doesn't need, made beside the right one. */
  extraCalls: ScriptedCall[];
}

/**
 * The kinds of trace. Each changes one thing about a sound trace, so it
 * has one right label for each question.
 */
export const TRACE_KINDS = [
  'sound',
  'recovered',
  'wrong-fact',
  'unsupported-claim',
  'false-success',
  'wrong-tool',
  'extra-calls',
  'gave-up',
] as const;
export type TraceKind = (typeof TRACE_KINDS)[number];

/**
 * The judge questions the set has labels for, by the judge's name in
 * results: a `rubric` judge's rubric, else its reference.
 */
export type CalibrationQuestion =
  | 'correctness'
  | 'task-completion'
  | 'grounded-in-tools'
  | 'tool-use';

type Label = 'pass' | 'fail';

/**
 * Each trace kind's label for each question. `null` means the kind has no
 * one right answer to the question, so its traces get no label for it.
 */
export const LABELS: Record<
  TraceKind,
  Record<CalibrationQuestion, Label | null>
> = {
  // The right call, and an answer it supports.
  sound: {
    correctness: 'pass',
    'task-completion': 'pass',
    'grounded-in-tools': 'pass',
    'tool-use': 'pass',
  },
  // A call that fails, then the client finds its way to the right one.
  recovered: {
    correctness: 'pass',
    'task-completion': 'pass',
    'grounded-in-tools': 'pass',
    'tool-use': 'pass',
  },
  // The right call, and an answer that contradicts its result.
  'wrong-fact': {
    correctness: 'fail',
    'task-completion': 'fail',
    'grounded-in-tools': 'fail',
    'tool-use': 'pass',
  },
  // The right answer, plus a claim no tool result supports. Whether that
  // claim makes the answer incorrect depends on how strict a reader is.
  'unsupported-claim': {
    correctness: null,
    'task-completion': 'pass',
    'grounded-in-tools': 'fail',
    'tool-use': 'pass',
  },
  // The only call fails, and the answer gives the right value anyway: a
  // claim of success that no tool result supports.
  'false-success': {
    correctness: 'pass',
    'task-completion': 'fail',
    'grounded-in-tools': 'fail',
    'tool-use': 'fail',
  },
  // The wrong tool or arguments, and an answer true to what came back.
  'wrong-tool': {
    correctness: 'fail',
    'task-completion': 'fail',
    'grounded-in-tools': 'pass',
    'tool-use': 'fail',
  },
  // The right answer, with calls the task didn't need.
  'extra-calls': {
    correctness: 'pass',
    'task-completion': 'pass',
    'grounded-in-tools': 'pass',
    'tool-use': 'fail',
  },
  // A call fails because of the client's own mistake, and it stops.
  'gave-up': {
    correctness: 'fail',
    'task-completion': 'fail',
    'grounded-in-tools': 'pass',
    'tool-use': 'fail',
  },
};

function read(file: string): ScriptedCall {
  return {
    server: 'files',
    tool: 'read_text_file',
    args: { path: `{files}/${file}` },
  };
}

function list(folder: string): ScriptedCall {
  return {
    server: 'files',
    tool: 'list_directory',
    args: { path: folder ? `{files}/${folder}` : '{files}' },
  };
}

function calc(operation: string, a: number, b: number): ScriptedCall {
  return { server: 'mock', tool: 'calculate', args: { operation, a, b } };
}

function weather(args: Record<string, unknown>): ScriptedCall {
  return { server: 'mock', tool: 'get_weather', args };
}

/** Where a stale value for a deployed setting is written. */
const STALE_SOURCES = {
  readme: { file: 'README.md', name: 'README' },
  architecture: { file: 'docs/architecture.md', name: 'architecture document' },
};

/** A deployed setting in config/service.json, and a stale value for it in another file. */
function setting(
  id: string,
  input: string,
  what: string,
  right: string,
  wrong: string,
  stale: { in: keyof typeof STALE_SOURCES; value: string },
  extraClaim: string
): Template {
  const source = STALE_SOURCES[stale.in];
  return {
    id,
    input,
    reference: `${right}. An answer that gives another value, or none, is incorrect.`,
    call: read('config/service.json'),
    answer: `Larkspur's deployed configuration sets ${what} to ${right}.`,
    wrongAnswer: `Larkspur's deployed configuration sets ${what} to ${wrong}.`,
    extraClaim,
    wrongCall: read(source.file),
    wrongCallAnswer: `The ${source.name} gives ${what} as ${stale.value}.`,
    failingCall: read('config/services.json'),
    recovery: [list('config')],
    gaveUpAnswer: `Reading Larkspur's configuration returned an error, so I can't tell you ${what}.`,
    extraCalls: [read('config/service.json'), read('team/owners.md')],
  };
}

/** A calculation on the mock server's calculator. */
function arithmetic(
  id: string,
  input: string,
  operation: string,
  a: number,
  b: number,
  right: string,
  wrong: string,
  wrongOperation: string,
  wrongCallAnswer: string
): Template {
  return {
    id,
    input,
    reference: `${right}. An answer that gives another number, or none, is incorrect.`,
    call: calc(operation, a, b),
    answer: `The answer is ${right}.`,
    wrongAnswer: `The answer is ${wrong}.`,
    extraClaim: 'I checked it with a second calculation, which agreed.',
    wrongCall: calc(wrongOperation, a, b),
    wrongCallAnswer,
    // `times`, `over` and so on aren't operations the calculator takes.
    failingCall: calc(`${operation}s`, a, b),
    recovery: [],
    gaveUpAnswer:
      "The calculator returned an error for that request, so I can't give you the answer.",
    extraCalls: [calc(operation, a, b), calc(operation, b, a)],
  };
}

function forecast(city: string, extraClaim: string): Template {
  return {
    id: `weather-${city.toLowerCase()}`,
    input: `What's the weather in ${city} right now?`,
    reference: `20°C and sunny in ${city}. An answer that gives other weather, or none, is incorrect.`,
    call: weather({ city }),
    answer: `It's 20°C and sunny in ${city}.`,
    wrongAnswer: `It's 12°C and raining in ${city}.`,
    extraClaim,
    wrongCall: { server: 'mock', tool: 'get_city_info', args: { city } },
    wrongCallAnswer: `The city information for ${city} lists 15°C and partly cloudy.`,
    failingCall: weather({ location: city }),
    recovery: [],
    gaveUpAnswer: `The weather tool returned an error, so I can't tell you the weather in ${city}.`,
    extraCalls: [
      weather({ city }),
      { server: 'mock', tool: 'echo', args: { message: city } },
    ],
  };
}

const TEMPLATES: Template[] = [
  setting(
    'config-port',
    'What port does the Larkspur service listen on in its deployed configuration?',
    'the port',
    '7341',
    '7431',
    { in: 'readme', value: '7300' },
    'That port is also open to the public internet.'
  ),
  setting(
    'config-workers',
    "How many workers does Larkspur's deployed configuration run?",
    'the number of workers',
    '12',
    '16',
    { in: 'architecture', value: 'eight' },
    'Each worker handles about 400 messages a second.'
  ),
  setting(
    'config-retention',
    'How many days does Larkspur keep a message in the queue, as deployed?',
    'message retention',
    '21 days',
    '30 days',
    { in: 'architecture', value: '14 days' },
    'Messages older than that are archived to cold storage.'
  ),
  setting(
    'config-payload',
    "What is the largest payload Larkspur's deployed configuration accepts?",
    'the largest payload',
    '512 KB',
    '1 MB',
    { in: 'architecture', value: '256 KB' },
    'Larger payloads are split into chunks automatically.'
  ),
  {
    id: 'changelog-dead-letter',
    input:
      'Which Larkspur release added the dead-letter queue, and when was it released?',
    reference:
      'Release 3.4.0, released on 2026-03-02. An answer that gives another release or date, or none, is incorrect.',
    call: read('CHANGELOG.md'),
    answer:
      'Release 3.4.0 added the dead-letter queue. It was released on 2026-03-02.',
    wrongAnswer:
      'Release 3.3.0 added the dead-letter queue. It was released on 2026-01-15.',
    extraClaim: 'It was the most requested feature that year.',
    wrongCall: read('config/service.json'),
    wrongCallAnswer:
      "Larkspur's configuration has the dead-letter queue turned on, but it doesn't say which release added it.",
    failingCall: read('CHANGES.md'),
    recovery: [list('')],
    gaveUpAnswer:
      "Reading Larkspur's changelog returned an error, so I can't tell you which release added it.",
    extraCalls: [read('CHANGELOG.md'), read('README.md')],
  },
  {
    id: 'owners-scheduler',
    input: "Who owns Larkspur's scheduler module?",
    reference:
      'Ines Duarte. An answer that names someone else, or no one, is incorrect.',
    call: read('team/owners.md'),
    answer: 'Ines Duarte owns the scheduler module.',
    wrongAnswer: 'Priya Raman owns the scheduler module.',
    extraClaim: 'She has owned it since 2024.',
    wrongCall: read('docs/architecture.md'),
    wrongCallAnswer:
      "The architecture document describes the scheduler module, but it doesn't name its owner.",
    failingCall: read('team/owner.md'),
    recovery: [list('team')],
    gaveUpAnswer:
      "Reading Larkspur's owners file returned an error, so I can't tell you who owns the scheduler.",
    extraCalls: [read('team/owners.md'), read('incidents/2026-02-11.md')],
  },
  {
    id: 'incident-duration',
    input: 'How long did the Larkspur outage on 2026-02-11 last?',
    reference:
      '47 minutes (09:12 to 09:59 UTC). An answer that gives another length, or none, is incorrect.',
    call: read('incidents/2026-02-11.md'),
    answer: 'The outage lasted 47 minutes, from 09:12 to 09:59 UTC.',
    wrongAnswer: 'The outage lasted 74 minutes, from 09:12 to 10:26 UTC.',
    extraClaim: 'About 3,000 producers were affected.',
    wrongCall: list('incidents'),
    wrongCallAnswer:
      "There is a report for an incident on 2026-02-11, but the folder listing doesn't say how long it lasted.",
    failingCall: read('incidents/2026-11-02.md'),
    recovery: [list('incidents')],
    gaveUpAnswer:
      "Reading the incident report returned an error, so I can't tell you how long the outage lasted.",
    extraCalls: [read('incidents/2026-02-11.md'), read('CHANGELOG.md')],
  },
  {
    id: 'incident-cause',
    input: 'What caused the Larkspur outage on 2026-02-11?',
    reference:
      'The TLS certificate for the ingest endpoint expired. An answer that gives another cause, or none, is incorrect.',
    call: read('incidents/2026-02-11.md'),
    answer: 'The TLS certificate for the ingest endpoint expired.',
    wrongAnswer: 'The queue nodes ran out of disk space.',
    extraClaim: 'The same thing had happened in 2025.',
    wrongCall: read('CHANGELOG.md'),
    wrongCallAnswer:
      "The changelog doesn't mention an outage on 2026-02-11. Its nearest fix is for a retry storm, in 3.2.1.",
    failingCall: read('incident/2026-02-11.md'),
    recovery: [list('')],
    gaveUpAnswer:
      "Reading the incident report returned an error, so I can't tell you what caused the outage.",
    extraCalls: [read('incidents/2026-02-11.md'), read('team/owners.md')],
  },
  arithmetic(
    'multiply-37-12',
    'What is 37 multiplied by 12?',
    'multiply',
    37,
    12,
    '444',
    '434',
    'add',
    'Adding 37 and 12 gives 49.'
  ),
  arithmetic(
    'divide-1296-54',
    'What is 1,296 divided by 54?',
    'divide',
    1296,
    54,
    '24',
    '26',
    'subtract',
    '1,296 minus 54 is 1,242.'
  ),
  arithmetic(
    'subtract-815-297',
    'What is 815 minus 297?',
    'subtract',
    815,
    297,
    '518',
    '528',
    'add',
    '815 plus 297 is 1,112.'
  ),
  arithmetic(
    'add-46-789',
    'What is 46 plus 789?',
    'add',
    46,
    789,
    '835',
    '825',
    'multiply',
    '46 times 789 is 36,294.'
  ),
  arithmetic(
    'multiply-2.5-18',
    'What is 2.5 multiplied by 18?',
    'multiply',
    2.5,
    18,
    '45',
    '40',
    'divide',
    '2.5 divided by 18 is about 0.139.'
  ),
  arithmetic(
    'divide-9000-125',
    'What is 9,000 divided by 125?',
    'divide',
    9000,
    125,
    '72',
    '75',
    'multiply',
    '9,000 times 125 is 1,125,000.'
  ),
  forecast('Oslo', 'It should stay that way all week.'),
  forecast('Lima', 'That is the warmest day this month.'),
];

/** One trace of the set, as a dataset case. */
export interface CalibrationCase {
  id: string;
  input: string;
  expected: { answer: string };
  clientOptions: { steps: ScriptedCall[]; answer: string };
  metadata: { template: string; kind: TraceKind };
}

function trace(
  template: Template,
  kind: TraceKind
): CalibrationCase['clientOptions'] {
  const { call, answer } = template;
  switch (kind) {
    case 'sound':
      return { steps: [call], answer };
    case 'recovered':
      return {
        steps: [template.failingCall, ...template.recovery, call],
        answer,
      };
    case 'wrong-fact':
      return { steps: [call], answer: template.wrongAnswer };
    case 'unsupported-claim':
      return { steps: [call], answer: `${answer} ${template.extraClaim}` };
    case 'false-success':
      return { steps: [template.failingCall], answer };
    case 'wrong-tool':
      return { steps: [template.wrongCall], answer: template.wrongCallAnswer };
    case 'extra-calls':
      return { steps: [call, ...template.extraCalls], answer };
    case 'gave-up':
      return { steps: [template.failingCall], answer: template.gaveUpAnswer };
  }
}

/** Every template in every trace kind: 16 templates by 8 kinds, 128 cases. */
export function calibrationCases(): CalibrationCase[] {
  return TEMPLATES.flatMap((template) =>
    TRACE_KINDS.map((kind) => ({
      id: `${template.id}--${kind}`,
      input: template.input,
      expected: { answer: template.reference },
      clientOptions: trace(template, kind),
      metadata: { template: template.id, kind },
    }))
  );
}
