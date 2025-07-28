// ✅ Basic imports
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');

// ✅ Express setup
const app = express();
app.use(cors({
  origin: '*', // You can restrict this to your frontend URL
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type'],
}));
app.use(express.json());

// Helper to safely read JSON file (top-level)
function safeReadJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, JSON.stringify(fallback, null, 2));
      return fallback;
    }
    const data = fs.readFileSync(filePath, 'utf-8');
    if (!data.trim()) return fallback;
    return JSON.parse(data);
  } catch (err) {
    console.error(`Failed to read or parse ${filePath}:`, err.message);
    return fallback;
  }
}

// Allow frontend to access local audio files
app.use('/downloads', express.static(path.join(__dirname, 'downloads')));

// ✅ Path to yt-dlp
const ytDlpPath = path.join(__dirname, 'yt-dlp', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');

// ✅ Your YouTube API Keys (RapidAPI keys)
const YOUTUBE_API_KEYS = [
  "YOUR_API_KEY",
  "YOUR_API_KEY"
];
let currentKeyIndex = 0;

function getCurrentApiKey() {
  return YOUTUBE_API_KEYS[currentKeyIndex];
}
function switchApiKey() {
  currentKeyIndex = (currentKeyIndex + 1) % YOUTUBE_API_KEYS.length;
}

// ✅ Endpoint: Search YouTube
app.get('/search', async (req, res) => {
  const query = req.query.q;
  if (!query || typeof query !== 'string' || query.length < 2) {
    return res.status(400).json({ error: "Missing or invalid search query" });
  }

  let lastError = null;

  for (let i = 0; i < YOUTUBE_API_KEYS.length; i++) {
    const apiKey = getCurrentApiKey();

    try {
      const options = {
        method: 'GET',
        url: 'https://youtube-search-and-download.p.rapidapi.com/search',
        params: { query: query, type: 'v', sort: 'relevance' },
        headers: {
          'X-RapidAPI-Key': apiKey,
          'X-RapidAPI-Host': 'youtube-search-and-download.p.rapidapi.com'
        }
      };

      const response = await axios.request(options);
      const contents = response.data.contents || [];
      const results = contents
        .map((item) => ({
          title: item.video?.title || '',
          videoId: item.video?.videoId || '',
          thumbnail: item.video?.thumbnails?.[0]?.url || ''
        }))
        .filter(v => v.videoId && v.title);

      return res.json(results.slice(0, 8));

    } catch (err) {
      if (
        err.response &&
        (err.response.status === 403 || err.response.status === 429 ||
          (typeof err.response.data === 'object' &&
            JSON.stringify(err.response.data).toLowerCase().includes('quota')))
      ) {
        console.warn(`Quota hit on API key #${currentKeyIndex + 1}. Switching key...`);
        lastError = err;
        switchApiKey(); // Try next key
        continue;
      } else {
        console.error('Search error:', err.message);
        return res.status(500).json({ error: "YouTube search failed" });
      }
    }
  }

  if (lastError) {
    console.error("All API keys quota exceeded.");
    return res.status(429).json({ error: "YouTube API quota exceeded for all keys" });
  }

  return res.status(500).json({ error: "YouTube search failed" });
});

// ✅ Endpoint: Play (stream)
app.get('/play/:id', (req, res) => {
  const videoId = req.params.id;
  if (!videoId || typeof videoId !== 'string' || videoId.length < 5) {
    return res.status(400).json({ error: "Missing or invalid video ID" });
  }

  const ytUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const command = `"${ytDlpPath}" -f bestaudio -g "${ytUrl}"`;

  exec(command, (error, stdout, stderr) => {
    if (error) {
      console.error('yt-dlp error:', error.message);
      return res.status(500).json({ error: "Failed to fetch audio stream URL" });
    }
    const audioUrl = stdout.trim();
    res.json({ audioUrl });
  });
});

const sanitizeFilename = (title) => {
  return title.replace(/[<>:"\/\\|?*]+/g, '').replace(/\s+/g, '_');
};

app.post('/download', async (req, res) => {
  const { videoId, title, playlist } = req.body;
  if (!videoId || typeof videoId !== 'string' || videoId.length < 5 || !title || typeof title !== 'string' || title.length < 2) {
    return res.status(400).json({ error: "Missing or invalid videoId or title" });
  }

  const cleanTitle = sanitizeFilename(title);
  const filename = cleanTitle + '.webm';
  const filepath = path.join(__dirname, 'downloads', filename);

  if (fs.existsSync(filepath)) {
    return res.status(200).json({ message: "Already downloaded", file: filename });
  }

  const ytUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const command = `"${ytDlpPath}" -f bestaudio -o "${filepath}" "${ytUrl}"`;

  exec(command, (error, stdout, stderr) => {
    if (error) {
      console.error("Download failed:", error.message);
      return res.status(500).json({ error: "Failed to download audio" });
    }

    console.log(`✅ Downloaded: ${filename}`);

    const playlistsPath = path.join(__dirname, 'playlists.json');
    const songMetaPath = path.join(__dirname, 'song-meta.json');

    const playlists = safeReadJson(playlistsPath, {});
    const songMeta = safeReadJson(songMetaPath, {});

    const songEntry = { videoId, title, file: filename };
    const playlistName = playlist || "Default";

    if (!playlists[playlistName]) playlists[playlistName] = [];
    if (!playlists[playlistName].find(s => s.videoId === videoId)) {
      playlists[playlistName].push(songEntry);
    }

    songMeta[videoId] = songEntry;

    try {
      fs.writeFileSync(playlistsPath, JSON.stringify(playlists, null, 2));
    } catch (err) {
      console.error(`Failed to write ${playlistsPath}:`, err.message);
    }
    try {
      fs.writeFileSync(songMetaPath, JSON.stringify(songMeta, null, 2));
    } catch (err) {
      console.error(`Failed to write ${songMetaPath}:`, err.message);
    }

    return res.status(200).json({ message: "Downloaded & added", file: filename });
  });
});

// ✅ Endpoint: Get library
app.get('/library', (req, res) => {
  const playlistsPath = path.join(__dirname, 'playlists.json');
  const songMetaPath = path.join(__dirname, 'song-meta.json');
  try {
    const playlists = safeReadJson(playlistsPath, {});
    const songMeta = safeReadJson(songMetaPath, {});
    const response = {};
    for (const [playlistName, songs] of Object.entries(playlists)) {
      response[playlistName] = songs.map(song => ({
        ...song,
        filePath: `/downloads/${song.file}`
      }));
    }
    res.json(response);
  } catch (err) {
    console.error("❌ Failed to load library:", err.message);
    res.status(500).json({ error: "Failed to fetch library" });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// Catch-all error handler
app.use((err, req, res, next) => {
  console.error('Unexpected error:', err);
  res.status(500).json({ error: 'Internal server error' });
});


// ✅ Start server
const PORT = 5000;
app.listen(PORT, () => {
  console.log(`✅ Backend running at http://localhost:${PORT}`);
});
