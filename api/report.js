const fs = require('node:fs');
const path = require('node:path');

module.exports = (req, res) => {
  try {
    const filePath = path.join(process.cwd(), 'data', 'report-data.json');
    const raw = fs.readFileSync(filePath, 'utf8');
    const report = JSON.parse(raw);

    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({
      ...report,
      source: 'data-file',
      servedAt: new Date().toISOString(),
    });
  } catch (error) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(500).json({
      source: 'error',
      error: 'No se pudo leer data/report-data.json',
    });
  }
};
