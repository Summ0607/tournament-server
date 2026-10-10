const fs = require('fs');
const path = require('path');

function normalizeEventRingConfig(config) {
  const dimensions = {};
  for (const field of ['ringConfigX', 'ringConfigY']) {
    const value = config && config[field];
    const number = value == null || value === '' ? 0 : Number(value);
    if ((value != null && typeof value !== 'number' && typeof value !== 'string')
      || !Number.isSafeInteger(number) || number < 0) {
      const error = new Error(`${field} must be a non-negative whole number`);
      error.statusCode = 400;
      throw error;
    }
    dimensions[field] = number;
  }
  return dimensions;
}

function createEventConfigStore(eventsRoot) {
  function configFile(eventName) {
    return path.join(eventsRoot, eventName, 'event-config.json');
  }

  function readEventConfig(eventName) {
    const name = String(eventName || '').trim();
    const defaults = {
      eventName: name,
      name,
      location: '',
      date: '',
      ringConfigX: 0,
      ringConfigY: 0,
      createdAt: '',
      updatedAt: ''
    };
    if (!name || !fs.existsSync(configFile(name))) return defaults;

    const raw = JSON.parse(fs.readFileSync(configFile(name), 'utf8'));
    const { ringConfig, ...metadata } = raw;
    const dimensions = normalizeEventRingConfig(raw);
    if (raw.ringConfigX == null && raw.ringConfigY == null && typeof ringConfig === 'string') {
      const match = ringConfig.match(/^\s*(\d+)\s*[x×]\s*(\d+)\s*$/i);
      if (match) {
        Object.assign(dimensions, normalizeEventRingConfig({
          ringConfigX: match[1],
          ringConfigY: match[2]
        }));
      }
    }
    return {
      ...defaults,
      ...metadata,
      ...dimensions,
      eventName: name,
      name: String(raw.name || name).trim() || name
    };
  }

  function writeEventConfig(eventName, config) {
    const name = String(eventName || '').trim();
    if (!name) throw new Error('eventName is required');

    const payload = {
      eventName: name,
      name: String(config && config.name || name).trim() || name,
      location: String(config && config.location || '').trim(),
      date: String(config && config.date || '').trim(),
      ...normalizeEventRingConfig(config),
      createdAt: String(config && config.createdAt || '').trim(),
      updatedAt: new Date().toISOString()
    };
    if (!payload.createdAt) payload.createdAt = payload.updatedAt;
    fs.writeFileSync(configFile(name), JSON.stringify(payload, null, 2));
    return payload;
  }

  return { readEventConfig, writeEventConfig };
}

module.exports = { createEventConfigStore, normalizeEventRingConfig };
