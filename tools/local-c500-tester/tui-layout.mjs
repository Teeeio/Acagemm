const finiteDimension = (value, fallback) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : fallback;
};

export const deriveDashboardLayout = ({ columns, rows } = {}) => {
  const viewportColumns = finiteDimension(columns, 120);
  const viewportRows = finiteDimension(rows, 40);
  const density = viewportRows >= 48 ? 'full' : viewportRows >= 34 ? 'compact' : 'tight';
  return {
    columns: viewportColumns,
    rows: viewportRows,
    height: Math.max(1, viewportRows - 2),
    density,
    candidateLimit: density === 'full' ? 5 : density === 'compact' ? 4 : viewportRows >= 27 ? 3 : 1,
    showMissionDetail: density === 'full',
    showEvidencePanels: density === 'full',
    showCompactSummary: density === 'compact',
    showEvents: density === 'full',
  };
};
