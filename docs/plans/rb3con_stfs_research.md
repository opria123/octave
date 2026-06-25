# Rock Band 3 STFS and CON Container Research

This document outlines the binary structures, parsing logic, file storage, and decryption mechanisms used by the Onyx toolkit to import and extract files from Xbox 360 STFS (CON) packages containing Rock Band 3 song assets.

---

## 1. STFS Container Binary Structure

The **Secure Transacted File System (STFS)** is a proprietary container file format developed by Microsoft for the Xbox 360. It is used to package saved games, profiles, and downloadable content (DLC) into console-signed (`CON `) or retail-signed (`LIVE`/`PIRS`) files.

### 1.1 Header Structure and Offsets

An STFS container is divided into a metadata header region followed by a sequence of 4096-byte blocks.

- **Magic Bytes:** Located at offset `0x00`, identifying the package type:
  - `"CON "` (Console-signed: user profiles, game saves)
  - `"LIVE"` (Microsoft-signed: Marketplace DLC)
  - `"PIRS"` (Microsoft-signed: retail updates)
- **Header Size:** The metadata header itself spans **`0x971A` bytes**.
- **Padding & Alignment:** Because STFS data blocks are aligned to `0x1000` (4096-byte) boundaries, the header is padded up to the nearest multiple of `0x1000`. This places the start of the data area at offset **`0xA000`**.

### 1.2 STFS Volume Descriptor

The geometry and configuration of the file system are defined in the **STFS Volume Descriptor**, which is located at offset **`0x37A`** (relative to the file start) and spans **`0x24` bytes**:

| Offset (Rel to 0x37A) | Size     | Description                                       |
| :-------------------- | :------- | :------------------------------------------------ |
| `0x00`                | 1 byte   | Volume Descriptor Size (typically `0x24`)         |
| `0x01`                | 1 byte   | Volume Descriptor Type / Reserved                 |
| `0x02`                | 1 byte   | Block Separation                                  |
| `0x03`                | 2 bytes  | File Table Block Count (big-endian short)         |
| `0x05`                | 3 bytes  | File Table Block Number (little-endian int24)     |
| `0x08`                | 20 bytes | SHA-1 Hash of the top-level hash table            |
| `0x1C`                | 4 bytes  | Total Allocated Block Count (little-endian int)   |
| `0x20`                | 4 bytes  | Total Unallocated Block Count (little-endian int) |

### 1.3 Block Sizing and Interleaved Hashing

Data blocks are exactly **`0x1000` (4096) bytes** in size. To verify integrity, SHA-1 hash tables are interleaved directly into the data block stream.

- **Level 0 (L0) Hash Tables:** A 1-block (4KB) hash table appears every **170 (`0xAA`) data blocks**. It contains 170 records of 24 bytes (each containing a 20-byte SHA-1 hash, 1-byte status, and 3-byte next-block index).
- **Level 1 (L1) Hash Tables:** A 1-block hash table appears every **$170^2 = 28,900$ data blocks**.
- **Level 2 (L2) Hash Tables:** A 1-block hash table appears every **$170^3 = 4,913,000$ data blocks**.

Because hash blocks are injected into the file, the physical offset of a data block index $N$ is not simply $N \times 0x1000$. The physical block index $P(N)$ must account for all preceding hash blocks:
$$P(N) = N + \text{NumL0}(N) + \text{NumL1}(N) + \text{NumL2}(N)$$
Where:

- $\text{NumL0}(N) = 1 + \lfloor N / 170 \rfloor$
- $\text{NumL1}(N) = 1 + \lfloor N / 28900 \rfloor$
- $\text{NumL2}(N) = 1 + \lfloor N / 4913000 \rfloor$

The physical file offset is then calculated as:
$$\text{Offset} = 0xA000 + (P(N) \times 0x1000)$$

---

## 2. Directory Listing Parsing and File Extraction

Onyx reads the STFS directory structure and extracts files using the following procedure:

### 2.1 File Listing Entry Layout

The directory table is composed of 64-byte (`0x40`) records. It begins at the physical offset computed from the `File Table Block Number` (found at `0x37E` in the Volume Descriptor) and extends for `File Table Block Count` blocks.

Each 64-byte file listing entry follows this layout:

- **`0x00 - 0x27` (40 bytes):** Filename (ASCII, null-padded).
- **`0x28` (1 byte):** Filename length (lower 6 bits) and Flags:
  - Bit 6 (`0x40`): Directory indicator flag.
  - Bit 7 (`0x80`): Block allocation type (set if blocks are consecutively allocated; clear if chained).
- **`0x29 - 0x2B` (3 bytes):** Number of blocks allocated (little-endian signed int24).
- **`0x2C - 0x2E` (3 bytes):** Copy of the block count (little-endian signed int24).
- **`0x2F - 0x31` (3 bytes):** Starting block number (little-endian signed int24).
- **`0x32 - 0x33` (2 bytes):** Path indicator (big-endian short). A value of `0xFFFF` denotes the root directory; other values index into the entry table to reference the parent directory.
- **`0x34 - 0x37` (4 bytes):** File size in bytes (big-endian unsigned int).
- **`0x38 - 0x3B` (4 bytes):** Update timestamp (FAT date/time format).
- **`0x3C - 0x3F` (4 bytes):** Access timestamp (FAT date/time format).

### 2.2 Directory Parsing and Reconstruction

1. Onyx iterates sequentially over the `0x40`-byte records in the file table blocks until it hits an entry composed entirely of null bytes.
2. It tracks directory nodes using the **Path Indicator** index to reconstruct the folder hierarchy.
3. For file extraction, Onyx extracts the `Starting Block Number` and the `File Size` of the target entry.
4. If the allocation flag (bit 7 of `0x28`) is set, the file blocks are contiguous, and Onyx reads the necessary number of blocks sequentially (skipping interleaved hash tables).
5. If the blocks are not contiguous, Onyx reads the hash table records to resolve the block pointer chain (similar to a File Allocation Table).
6. The retrieved blocks are concatenated, and the final block is truncated to the exact file size.

---

## 3. Storage of Rock Band 3 Files inside STFS

Within a Rock Band 3 STFS (`.CON`) package, files are stored using a standardized path convention inside the container's virtual directory structure:

- **MIDI Charts (.mid):** Located at `songs/songname/songname.mid` (where `songname` is the shortname of the track). This file contains the MIDI notes representing gameplay tracks (Real Guitar, Pro Drums, Vocals, Keys, etc.) along with lighting, camera, and venue staging event cues.
- **MOGG Multi-channel Audio (.mogg):** Located at `songs/songname/songname.mogg`. This container file packs the multitrack audio stems (separate channels for bass, drums, guitar, vocals, keys, backing tracks).
- **Song Metadata (.dta):** Typically located at `songs/songs.dta` or in the root. This is a LISP-syntax configuration file providing track indexes, pan/volume properties, difficulties, and other catalog info.

---

## 4. Encryption and Decryption Mechanisms

- **Container Layer:** The STFS package uses RSA signing (`CON` signature blocks) to verify header metadata and hash chains, but the file data blocks themselves are stored in plaintext.
- **Audio Layer (MOGG Encryption):** Harmonix applies proprietary encryption to the `.mogg` audio container files.
  - **Version 10:** Stored as plaintext (a plain binary header followed by standard OGG Vorbis streams).
  - **Versions 11 - 17:** Stored as encrypted files. Rock Band 3 files and DLCs commonly use **MOGG Version 13 (`0x0D`)**.
  - **Keystream Decryption (themethod3):** The encryption is a custom symmetric keystream obfuscation algorithm. To decrypt it, the parser reads the MOGG header version, derives a cryptographic seed/key based on the file metadata and song name, generates the custom keystream, and XORs the encrypted payload to recover the raw multi-channel OGG Vorbis stream.
