export const LOCAL_C500_RUNTIME_CONTRACT_VERSION = 5;

export const isCurrentLocalC500Runtime = (health = {}) => (
  health?.service === 'operator-studio-client-runtime'
  && health?.__bridge?.runtimeContractVersion === LOCAL_C500_RUNTIME_CONTRACT_VERSION
);
