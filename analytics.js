// analytics.js
export function track(eventName, properties = {}) {
  if (typeof window !== 'undefined' && window.va) {
    window.va('event', { name: eventName, data: properties });
  }
}