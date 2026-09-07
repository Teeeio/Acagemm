// Version 9 adds bounded dispatch/cancellation, full-round budgets and frozen experience input.
export const LOCAL_C500_RUNTIME_CONTRACT_VERSION = 9;

export const isCurrentLocalC500Runtime = (health = {}) => (
  health?.service === 'operator-studio-client-runtime'
  && health?.__bridge?.runtimeContractVersion === LOCAL_C500_RUNTIME_CONTRACT_VERSION
);
