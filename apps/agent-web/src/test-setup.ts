import '@testing-library/jest-dom/vitest';

// jsdom has no layout engine, so it does not implement scrollIntoView. The chat
// log calls it on every new message.
Element.prototype.scrollIntoView = () => {};
