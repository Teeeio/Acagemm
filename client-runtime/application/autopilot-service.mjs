export const createAutopilotService = ({ advance }) => {
  if (typeof advance !== 'function') throw new TypeError('Autopilot service requires an advance implementation.');
  return Object.freeze({ advance });
};
