# pirunchino

Prepares audio you have the rights to use for offline playback on USB drives, car stereos and other music players. It fetches the audio of a YouTube video or playlist with [yt-dlp](https://github.com/yt-dlp/yt-dlp), converts it to MP3 with [FFmpeg](https://ffmpeg.org/), and gives each file clean names and tags so the artist and song are easy to find.

## Motivation

As a parent of a young child, I’m constantly reminded by pediatricians and parenting experts that screen time should be kept to a minimum. At the same time, ever since my son was born, I’ve loved having music playing in the background while we play—whether we’re in the living room, in his bedroom, or out on a road trip.

The challenge was finding a way to play his favorite songs anywhere without relying on screens. Most of the music he enjoys lives on online streaming platforms, which meant either pulling out a screen or losing playback whenever we hit a dead zone on the road.

Since both my home stereo and my car have USB ports, I built this project to bridge the gap. It helps me prepare and organize audio for offline, screen-free playback—for dancing, playing, or just setting the mood. All we need is a USB flash drive.

I hope others find this useful too. If you have any ideas, feedback, or suggestions, feel free to open an issue or reach out—I’d love to hear them!

## Disclaimer

This project is intended for personal and educational use only. Users are solely responsible for ensuring they have the necessary rights to download, convert, or use any media, and for complying with the Terms of Service and copyright laws of any third-party platforms.

pirunchino doesn't circumvent DRM or any other technical protection, and it doesn't work on protected content. It's meant for content you own, your own uploads, content under licenses like Creative Commons, or content you otherwise have permission to use.

This project isn't affiliated with or endorsed by YouTube or Google.

## Requirements

- Node.js 22.18 or newer, which runs TypeScript directly with no build step
- `yt-dlp` and `ffmpeg`:

  ```sh
  brew install yt-dlp ffmpeg                    # macOS
  sudo apt install ffmpeg pipx && pipx install yt-dlp   # Debian, Ubuntu
  winget install yt-dlp.yt-dlp Gyan.FFmpeg      # Windows
  ```

  Distribution packages of yt-dlp are often out of date, which is why the Linux line uses pipx.

- Optional: [Ollama](https://ollama.com) with a small local model for better names (see [Name cleanup](#name-cleanup))

There are no npm packages to install.

## Usage

Run the script from this directory:

```sh
node pirunchino.ts "https://www.youtube.com/watch?v=VIDEO_ID"
```

Keep the quotes around the URL, because zsh treats `?` and `&` as special characters.

### Where files are saved

Each MP3 goes in a subfolder of `downloads/` (created in the current directory if missing), or of the directory set with `--output`. `downloads/` is in `.gitignore`, so your music stays out of the repository:

| Link | Saved as |
| --- | --- |
| Single song | `downloads/various artists/Artist - Song.mp3` |
| Playlist | `downloads/Playlist Title/01 - Artist - Song.mp3` |

Playlist numbers follow each song's position in the playlist, with at least two digits (`01`, or `001` for playlists of 100+ songs).

Any link with a `list=` parameter counts as a playlist, including a video opened from a playlist. YouTube's auto-generated Mixes are the exception: their links also have `list=` (starting with `RD`), but only that one video is downloaded (split into songs if it's a compilation, see [Videos with several songs](#videos-with-several-songs)).

### Options

| Option | Description | Default |
| --- | --- | --- |
| `-o, --output <dir>` | Base directory for the subfolders; created if missing | `downloads` |
| `-b, --bitrate <kbps>` | MP3 bitrate: 128, 160, 192, 256 or 320 | 320 |
| `-f, --force` | Download songs again even if they're already saved | Off |
| `--no-split` | Keep a long video with chapters as one MP3 (see [Videos with several songs](#videos-with-several-songs)) | Off |
| `--retag <dir>` | Fix the names and tags of MP3s already downloaded (see below) | |
| `--dry-run` | With `--retag`, show the new names without changing anything | Off |
| `--model <name>` | Ollama model for cleaning up names | `$PIRUNCHINO_MODEL` or `qwen3:4b` |
| `--no-ai` | Use only the built-in rules (skip the local model) | Off |
| `-h, --help` | Show the help text | |

### Examples

Save to a specific directory:

```sh
node pirunchino.ts "https://youtu.be/VIDEO_ID" -o ~/Music
```

Download a playlist:

```sh
node pirunchino.ts "https://www.youtube.com/playlist?list=PLAYLIST_ID"
```

Run it through npm (note the `--` before the arguments):

```sh
npm start -- "https://youtu.be/VIDEO_ID" -o ~/Music
```

To use a `pirunchino` command from any directory, run `npm link` once from this directory.

## Name cleanup

YouTube titles are messy, like `HAPPY HANDS SONG - Sunny Kids🖐👩 - Official Video`, and most videos have no separate artist or song information. The script works the names out in two steps.

1. **Built-in rules (always on, offline).** These remove emoji, hashtags, `(Official Video)`, `Lyrics`, `HD` and similar noise, and drop `| Channel` suffixes. They find the artist using the channel name, and fall back to the channel when the title doesn't name an artist. They also turn ALL CAPS into title case. When most songs in a playlist put the song first (`Song - Series | Channel`), unclear titles in that playlist are read the same way.
2. **A local model (when Ollama is running).** A small model on your computer reviews the names with the title, channel and the start of the video description. It handles cases the rules miss, like duets, series names and descriptions in titles. It also tries to spell each artist the same way across a playlist and to use normal capitalization. Nothing is sent over the internet, and it's free.

Every answer from the model is checked before it's used, and a song keeps its rule-based name when its answer fails a check. A small model can shorten and reformat names, but it can't invent them.

- The title may only use words from the YouTube title. Descriptions often list other songs, so they're not a source for titles.
- The artist may only use words from the YouTube title or channel. Descriptions often credit songwriters, so they're not a source for artists either.
- Common small-model mistakes are rejected, like copying the title into the artist, listing an artist twice, or turning part of the title into a performer (`Sunny Kids & Abc` from `Sunny Kids - ABC - The Alphabet Song`).
- Spelling and capitalization come from the rule-based name where the same word appears there, so names like `Old MacDonald` keep their capitals. Missing accents are restored from the YouTube text.

### Setting up the local model

```sh
brew install ollama          # macOS; for Linux and Windows see https://ollama.com/download
ollama serve                 # or open the Ollama app, which runs it in the background
ollama pull qwen3:4b         # one-time 2.5 GB download
```

The default model, `qwen3:4b`, is released under the Apache 2.0 license, so it's free to use for any purpose. It uses about 3.2 GB of RAM while naming songs and handles Spanish and English.

To use another model, pull it, then pass `--model` or set `PIRUNCHINO_MODEL`:

```sh
ollama pull qwen2.5:3b
node pirunchino.ts --retag downloads --dry-run --model qwen2.5:3b
export PIRUNCHINO_MODEL=qwen2.5:3b    # or make it your default
```

Check a model's license before you choose it. For example, `qwen2.5:3b` gives names about as good as the default with less memory (2.2 GB), but its license doesn't allow commercial use. In tests, smaller models such as `qwen2.5:1.5b` and `granite3.3:2b` gave worse names than the rules alone. Stay with models of 4B parameters or less to keep memory under 4 GB.

Ollama is expected at `http://localhost:11434`. Set `OLLAMA_HOST` to use another address; the `http://` can be left out.

If Ollama isn't running or the model isn't downloaded, the script prints one notice and uses the rules only. `--no-ai` skips the model and hides the notice.

### Without the local model

The model is optional and only affects names. Downloading, converting, folders, numbering, tags, splitting videos and skipping saved songs work the same without it. Songs split from chapters never use it.

On a library of 335 songs, 297 got the same names with and without the model. Of the other 38, about 30 were better with it:

- Descriptions are dropped: `Five Little Ducks Learn to Count` becomes `Five Little Ducks`.
- Guests move into the artist: `Sunny Kids - The Shapes Song feat. Rainbow Crew` becomes `Sunny Kids & Rainbow Crew - The Shapes Song`.
- Duets are written the same way: `Sunny Kids y Max` becomes `Sunny Kids & Max`.

A few were worse with it. It sometimes drops a useful detail in brackets, as in `Finger Family (Vehicles)` becoming `Finger Family`, or shortens an artist's name. Check the `--dry-run` output if names matter to you.

Without the model, naming is instant. With it, naming 335 songs took about 9 minutes on a laptop, including fetching their YouTube details. You can download without it and improve the names later: start Ollama and run `node pirunchino.ts --retag downloads`.

## Videos with several songs

Some videos are compilations, like `Lullabies for Babies (2 Hours)`, with a tracklist of songs in their YouTube chapters. When a link to a single video points to one of these, the script splits it into one MP3 per song. This includes a video opened from a Mix (`&list=RD…`):

```sh
node pirunchino.ts "https://www.youtube.com/watch?v=VIDEO_ID&list=RDVIDEO_ID&start_radio=1"
```

```text
downloads/Lullabies for Babies (2 Hours) - Sunny Kids/
  01 - Sunny Kids - Twinkle Twinkle Little Star.mp3
  02 - Sunny Kids - Rock-a-bye Baby.mp3
  …
  20 - Sunny Kids - Brahms' Lullaby (feat. Moonlight Choir).mp3
```

- **When it splits:** the video has at least 3 chapters and is at least 10 minutes long. Shorter music videos with "intro/chorus" chapters stay whole. Use `--no-split` to keep any video as one file.
- **Naming:** the video title becomes the folder and album, the channel is the artist, and the chapter titles become song titles. Text repeated in most chapter titles, like `(For Babies)`, is removed. The local model isn't used, since chapter titles are already song names.
- **Downloading:** the audio is downloaded once and cut at the chapter times while converting.
- **Videos inside a playlist** aren't split.
- **If there's no tracklist,** the video has no chapters and is saved as one file. The script can't detect songs from the audio.

## Tags

Each MP3 gets clean ID3 tags, which is what music players display:

| Tag | Value |
| --- | --- |
| Title, Artist | The cleaned song and artist |
| Album | Playlist title (not set for single songs) |
| Album artist | The playlist's artist, or `Various Artists` when it mixes artists |
| Track | `3/12` |
| Year | Release or upload year |
| Comment | The YouTube link (with `&t=<seconds>` for songs split from a longer video) |

The YouTube link in the comment is how the script recognizes songs it already downloaded. Running a playlist again downloads only the new songs, even if names changed in between.

## Fixing existing files

`--retag` renames and retags MP3s you already have, including files from older versions of this script. It doesn't download or re-encode the audio. First, check what it would do:

```sh
node pirunchino.ts --retag downloads --dry-run
```

Then apply it:

```sh
node pirunchino.ts --retag downloads
```

It handles every MP3 under the directory, one folder at a time:

- The folder name becomes the album.
- An existing `NN - ` prefix gives the track number.
- Files in `various artists` get no number.

It reads each file's YouTube link from its tags and fetches the current title and channel. If a video is no longer on YouTube, that file's existing tags are used instead. Songs split from a longer video keep their chapter titles, matched by the `&t=` time in their link.

## Notes

- **Quality:** YouTube audio is already compressed, so the MP3 can't sound better than the source. The 320 kbps default keeps conversion loss as low as possible, but the file will be larger than the source.
- **Unavailable songs:** private or deleted videos in a playlist are skipped. The other songs are still saved, and the script ends with an error so you know some are missing.
- **Same name twice:** if two songs end up with the same name, the second gets ` (2)`.
- **Usage rights:** see the [Disclaimer](#disclaimer).

## Development

Run the tests:

```sh
npm test
```

## Troubleshooting

YouTube changes often, so most download errors come from an outdated `yt-dlp`. Update it first:

```sh
brew upgrade yt-dlp          # macOS
pipx upgrade yt-dlp          # Linux
winget upgrade yt-dlp.yt-dlp # Windows
```
