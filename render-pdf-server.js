const express = require('express');
const fetch = require('node-fetch');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// Adobe PDF to Word endpoint
app.post('/convert-pdf-to-word', upload.single('file'), async (req, res) => {
  const startTime = Date.now();
  
  try {
    const { file } = req;
    if (!file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    console.log(`Processing: ${file.originalname} (${(file.size / 1024 / 1024).toFixed(2)} MB)`);

    const clientId = process.env.ADOBE_CLIENT_ID;
    const clientSecret = process.env.ADOBE_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      return res.status(500).json({ error: 'Adobe credentials missing. Set ADOBE_CLIENT_ID and ADOBE_CLIENT_SECRET' });
    }

    // 1. Get Adobe Access Token
    const tokenRes = await fetch('https://pdf-services.adobe.io/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'client_credentials'
      })
    });

    const tokenData = await tokenRes.json();
    if (!tokenRes.ok) {
      throw new Error(`Adobe token error: ${JSON.stringify(tokenData)}`);
    }
    const accessToken = tokenData.access_token;
    console.log('✅ Adobe token obtained');

    // 2. Upload PDF
    const uploadRes = await fetch('https://pdf-services.adobe.io/assets', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/pdf',
        'Content-Disposition': 'attachment; filename="document.pdf"'
      },
      body: file.buffer
    });

    const assetData = await uploadRes.json();
    if (!uploadRes.ok) {
      throw new Error(`Upload failed: ${JSON.stringify(assetData)}`);
    }
    const assetId = assetData.assetID;
    console.log('✅ PDF uploaded, asset ID:', assetId);

    // 3. Convert to Word
    const convertRes = await fetch('https://pdf-services.adobe.io/operation/exportpdf', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        assetID: assetId,
        targetFormat: 'DOCX'
      })
    });

    const jobData = await convertRes.json();
    if (!convertRes.ok) {
      throw new Error(`Conversion failed: ${JSON.stringify(jobData)}`);
    }
    const jobId = jobData.jobID;
    console.log('✅ Conversion job started, job ID:', jobId);

    // 4. Poll for completion
    let status = 'pending';
    let resultUrl = '';
    let attempts = 0;
    const maxAttempts = 30;

    while (status !== 'done' && attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      const statusRes = await fetch(`https://pdf-services.adobe.io/operation/exportpdf/${jobId}/status`, {
        headers: { 'Authorization': `Bearer ${accessToken}` }
      });
      const statusData = await statusRes.json();
      status = statusData.status;
      console.log(`Status: ${status} (attempt ${attempts + 1}/${maxAttempts})`);
      
      if (status === 'done') {
        resultUrl = statusData.asset.assetID;
      }
      attempts++;
    }

    if (status !== 'done') {
      throw new Error('Conversion timeout after 60 seconds');
    }
    console.log('✅ Conversion complete');

    // 5. Download result
    const downloadRes = await fetch(`https://pdf-services.adobe.io/asset/${resultUrl}/content`, {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });

    const docxBuffer = await downloadRes.buffer();
    const endTime = Date.now();
    console.log(`Total time: ${(endTime - startTime) / 1000} seconds`);

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', 'attachment; filename="converted.docx"');
    res.send(docxBuffer);

  } catch (error) {
    console.error('Conversion error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    env: {
      hasAdobeId: !!process.env.ADOBE_CLIENT_ID,
      hasAdobeSecret: !!process.env.ADOBE_CLIENT_SECRET
    }
  });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`✅ Adobe PDF service running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});
