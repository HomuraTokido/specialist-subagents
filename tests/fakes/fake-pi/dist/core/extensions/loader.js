// seat-runner loads its write-boundary extension through this. The fake only runs the factory against
// a stub `pi` that records the handlers (event -> [handler]); the fake createAgentSession calls them.
export const loadExtensionFromFactory = async (factory, cwd, eventBus, runtime, name) => {
  const handlers = new Map();
  factory({ on: (event, handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]) });
  return { name, handlers };
};
