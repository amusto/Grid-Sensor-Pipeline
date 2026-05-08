import { validateSensorEvent } from '../lib/validator';

const VALID = {
  sensorId: 'sensor-abc-123',
  timestamp: '2026-05-08T12:00:00Z',
  readingType: 'voltage' as const,
  value: 120.0,
  unit: 'V',
  gridZone: 'zone-1',
};

describe('validateSensorEvent', () => {
  it('accepts a fully populated valid event', () => {
    expect(validateSensorEvent(VALID)).toEqual(VALID);
  });

  it('accepts an event without optional gridZone', () => {
    const { gridZone: _gz, ...rest } = VALID;
    expect(validateSensorEvent(rest)).toEqual(rest);
  });

  it.each([
    ['sensor_abc'], // underscore
    ['Sensor-abc'], // uppercase
    ['sensor-abc!'], // bad char
    ['sensor-'],     // dangling dash but no body
    [''],
    ['random-id'],   // missing sensor- prefix
    ['SENSOR-001'],  // upper prefix
  ])('rejects invalid sensorId %p', (sensorId) => {
    expect(() => validateSensorEvent({ ...VALID, sensorId })).toThrow();
  });

  it.each([
    '2026-05-08 12:00:00',  // space, not 'T'
    '2026/05/08T12:00:00Z', // slashes
    'yesterday',
    '',
  ])('rejects non-ISO timestamp %p', (timestamp) => {
    expect(() => validateSensorEvent({ ...VALID, timestamp })).toThrow();
  });

  it('accepts a timestamp with a +HH:MM offset', () => {
    expect(() =>
      validateSensorEvent({ ...VALID, timestamp: '2026-05-08T08:00:00-04:00' }),
    ).not.toThrow();
  });

  it.each(['power', 'humidity', 'PRESSURE', '', 42, null])(
    'rejects invalid readingType %p',
    (readingType) => {
      expect(() => validateSensorEvent({ ...VALID, readingType })).toThrow();
    },
  );

  it.each([NaN, Infinity, -Infinity])('rejects non-finite value %p', (v) => {
    expect(() => validateSensorEvent({ ...VALID, value: v })).toThrow();
  });

  it('rejects non-number value', () => {
    expect(() => validateSensorEvent({ ...VALID, value: '120' })).toThrow();
  });

  it('rejects when a required field is missing', () => {
    const { value: _v, ...rest } = VALID;
    expect(() => validateSensorEvent(rest)).toThrow();
  });

  it('rejects unit longer than 16 chars', () => {
    expect(() =>
      validateSensorEvent({ ...VALID, unit: 'a'.repeat(17) }),
    ).toThrow();
  });

  it('rejects empty-string unit', () => {
    expect(() => validateSensorEvent({ ...VALID, unit: '' })).toThrow();
  });

  it('rejects unknown extra keys (strict mode)', () => {
    expect(() =>
      validateSensorEvent({ ...VALID, attacker: 'payload' }),
    ).toThrow();
  });

  it.each([null, undefined, 'not-an-object', 42, []])(
    'rejects non-object input %p',
    (input) => {
      expect(() => validateSensorEvent(input)).toThrow();
    },
  );

  it('returns a typed SensorEvent (no extra fields, no Zod artifacts)', () => {
    const result = validateSensorEvent(VALID);
    expect(Object.keys(result).sort()).toEqual(
      ['gridZone', 'readingType', 'sensorId', 'timestamp', 'unit', 'value'].sort(),
    );
  });
});
