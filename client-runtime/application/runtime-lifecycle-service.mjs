// Advancement runs inside the caller's exclusive scope; reads use atomic committed snapshots without entering the mutation queue.
// Reads never share an in-flight advance: they observe a committed snapshot.
export const createRuntimeLifecycleService = ({ readState, persistState, describeRuntime, pipeline, canAdvance = () => true }) => {
  const load = async (recover) => {
    const runtime = await describeRuntime();
    const state = await readState({ recover, ensureWorkspace: false });
    return { state: { ...state, runtime }, runtime };
  };

  const read = async () => (await load(false)).state;
  const advance = async () => {
    if (!canAdvance()) throw Object.assign(new Error('The runtime owner is no longer alive.'), { code: 'RUNTIME_OWNER_UNAVAILABLE', status: 409 });
    const { state, runtime } = await load(true);
    if (state.workflowRecovery?.commandRecovery?.status === 'blocked') return state;
    const advanced = await pipeline.advance({ state, runtime });
    return advanced.changed ? persistState(advanced.state) : advanced.state;
  };

  return Object.freeze({ read, advance });
};
