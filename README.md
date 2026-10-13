# c-drive

Your computer used to tell you when it was working hard. c-drive brings that back: while Claude reads, writes and runs commands, a late-90s IBM hard disk spins up, grinds away and clicks through its seeks, then spins down when the turn ends.

## Install

At the prompt in Claude Code:

```
/plugin install c-drive --marketplace ammonitedigital/c-drive
```

Answer `y` to add the marketplace, then pick a scope.

## Use

- **`/hdd`** toggles the sound. Your choice is remembered across sessions.
- **`/defrag`** opens a Windows 98-style defrag window that works through the disk while Claude does.

A band above the prompt shows whether the drive is grinding or muted.

## Develop

```
claude --plugin-dir ./
claude plugin validate .
claude plugin test .
```

## Credits

Drive audio from [Hard Disk Drive IBM 1999](https://pixabay.com/sound-effects/technology-hard-disk-drive-ibm-1999-48823/) on Pixabay, used under the [Pixabay Content License](https://pixabay.com/service/license-summary/).

Code is MIT licensed. See [LICENSE](LICENSE).
