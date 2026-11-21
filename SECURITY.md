# Security

Please report security problems privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. Don't open a public issue for them.

Useful details: what you ran, what happened, and the versions of Node.js, yt-dlp and ffmpeg (`node --version`, `yt-dlp --version`, `ffmpeg -version`).

pirunchino runs yt-dlp and ffmpeg as separate programs, without a shell, and only talks to YouTube (through yt-dlp) and to your local Ollama server. Problems in yt-dlp, ffmpeg or Ollama themselves should go to those projects.
