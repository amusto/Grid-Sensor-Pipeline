import {
  evaluateThreshold,
  DEFAULT_THRESHOLDS,
  type ThresholdConfig,
} from '../lib/threshold';
import type { ReadingType, SensorEvent } from '../lib/types';

const baseEvent = (overrides: Partial<SensorEvent> = {}): SensorEvent => ({
  sensorId: 'sensor-001',
  timestamp: '2026-05-08T12:00:00Z',
  readingType: 'voltage',
  value: 120,
  unit: 'V',
  ...overrides,
});

describe('evaluateThreshold', () => {
  describe('voltage (114-126 V)', () => {
    it('nominal 120 V is in-range', () => {
      const r = evaluateThreshold(
        baseEvent({ readingType: 'voltage', value: 120 }),
      );
      expect(r.exceeded).toBe(false);
      expect(r.threshold).toBeUndefined();
    });

    it('113.9 V is below-min', () => {
      const r = evaluateThreshold(
        baseEvent({ readingType: 'voltage', value: 113.9 }),
      );
      expect(r.exceeded).toBe(true);
      expect(r.threshold).toEqual({ min: 114 });
      expect(r.details).toMatch(/below min/);
    });

    it('126.1 V is above-max', () => {
      const r = evaluateThreshold(
        baseEvent({ readingType: 'voltage', value: 126.1 }),
      );
      expect(r.exceeded).toBe(true);
      expect(r.threshold).toEqual({ max: 126 });
      expect(r.details).toMatch(/above max/);
    });

    it.each([114, 126, 115, 125, 120])('boundary %p V is in-range', (value) => {
      expect(
        evaluateThreshold(baseEvent({ readingType: 'voltage', value })).exceeded,
      ).toBe(false);
    });

    it('extreme low 0 V flags', () => {
      expect(
        evaluateThreshold(baseEvent({ readingType: 'voltage', value: 0 }))
          .exceeded,
      ).toBe(true);
    });
  });

  describe('frequency (59.5-60.5 Hz)', () => {
    it('nominal 60.0 Hz is in-range', () => {
      expect(
        evaluateThreshold(
          baseEvent({ readingType: 'frequency', value: 60, unit: 'Hz' }),
        ).exceeded,
      ).toBe(false);
    });

    it('59.4 Hz is below-min', () => {
      const r = evaluateThreshold(
        baseEvent({ readingType: 'frequency', value: 59.4, unit: 'Hz' }),
      );
      expect(r.exceeded).toBe(true);
      expect(r.threshold).toEqual({ min: 59.5 });
    });

    it('60.6 Hz is above-max', () => {
      const r = evaluateThreshold(
        baseEvent({ readingType: 'frequency', value: 60.6, unit: 'Hz' }),
      );
      expect(r.exceeded).toBe(true);
      expect(r.threshold).toEqual({ max: 60.5 });
    });

    it.each([59.5, 60.5])('boundary %p Hz is in-range', (value) => {
      expect(
        evaluateThreshold(
          baseEvent({ readingType: 'frequency', value, unit: 'Hz' }),
        ).exceeded,
      ).toBe(false);
    });
  });

  describe('non-thresholded reading types', () => {
    it.each<ReadingType>(['current', 'power_factor', 'temperature'])(
      '%s never exceeds, even at extreme values',
      (rt) => {
        const r = evaluateThreshold(
          baseEvent({ readingType: rt, value: 9999 }),
        );
        expect(r.exceeded).toBe(false);
        expect(r.details).toMatch(/no threshold configured/);
      },
    );
  });

  describe('config injection', () => {
    it('respects an overridden voltage range', () => {
      const config: ThresholdConfig = {
        ...DEFAULT_THRESHOLDS,
        voltage: { min: 100, max: 140 },
      };
      const r = evaluateThreshold(
        baseEvent({ readingType: 'voltage', value: 130 }),
        config,
      );
      expect(r.exceeded).toBe(false);
    });

    it('a tighter range will flag values that defaults accept', () => {
      const config: ThresholdConfig = {
        ...DEFAULT_THRESHOLDS,
        voltage: { min: 119, max: 121 },
      };
      const r = evaluateThreshold(
        baseEvent({ readingType: 'voltage', value: 122 }),
        config,
      );
      expect(r.exceeded).toBe(true);
      expect(r.threshold).toEqual({ max: 121 });
    });
  });

  describe('purity', () => {
    it('does not mutate the input event', () => {
      const event = baseEvent({ readingType: 'voltage', value: 130 });
      const snapshot = { ...event };
      evaluateThreshold(event);
      expect(event).toEqual(snapshot);
    });

    it('does not mutate the config object', () => {
      const config: ThresholdConfig = {
        frequency: { min: 59.5, max: 60.5 },
        voltage: { min: 114, max: 126 },
      };
      const snapshot = JSON.parse(JSON.stringify(config));
      evaluateThreshold(baseEvent({ value: 130 }), config);
      expect(config).toEqual(snapshot);
    });
  });
});
