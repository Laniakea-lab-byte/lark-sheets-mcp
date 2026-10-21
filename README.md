# lark-sheets-mcp

An [MCP](https://modelcontextprotocol.io) server that lets AI agents (Claude Desktop, Claude Code, OpenAI Codex and any MCP client) **read and write Lark / Feishu Sheets**.

The official Lark MCP covers Base, Docs, Chat and Calendar, but not cell-level Sheets editing. This server fills that gap so an agent can update a stock sheet, append report rows or fix a formula from a plain-language request.

🇮🇩 [Bahasa Indonesia di bawah](#bahasa-indonesia)

## Tools

| Tool | What it does |
|---|---|
| `sheet_tabs` | List tabs (id, title, size) |
| `sheet_read` | Read a range as displayed, raw or as formulas |
| `sheet_write` | Overwrite one range (strings starting with `=` become formulas) |
| `sheet_write_many` | Write several ranges in one call, across tabs |
| `sheet_append` | Append rows after the last filled row |
| `sheet_clear` | Clear values in a range and keep formatting |
| `sheet_insert_rows` | Insert rows or columns |
| `sheet_delete_rows` | Delete rows or columns |
| `sheet_add_tab` | Add a new tab |
| `sheet_find` | Find cells containing text |
| `sheet_check_access` | Check read/write permission without changing data |

Every tool accepts a full sheet link (`…/sheets/XXX?sheet=YYY`), a wiki link (`…/wiki/XXX`) or a bare spreadsheet token. Ranges accept a tab name or a tab id (`Stock!A1:D10`).

## Setup

**1. Create a Lark app.** In the [Lark Developer Console](https://open.larksuite.com/app), create a custom app. Add the `sheets:spreadsheet` scope (plus `wiki:wiki:readonly` if you use wiki links), then publish a version.

**2. Share each sheet with the app.** Open the sheet, then go to **••• → More → Add document app**, choose your app and give it **Can edit**.

**3. Install.**

```bash
git clone https://github.com/Laniakea-lab-byte/lark-sheets-mcp.git
cd lark-sheets-mcp
npm install
```

**4. Add it to your MCP client.** For Claude Desktop, edit `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "lark-sheets": {
      "command": "node",
      "args": ["/absolute/path/to/lark-sheets-mcp/src/server.mjs"],
      "env": {
        "LARK_APP_ID": "cli_xxxxxxxxxxxxxxxx",
        "LARK_APP_SECRET": "your_app_secret",
        "LARK_DOMAIN": "https://open.larksuite.com"
      }
    }
  }
}
```

For Codex, add it to `~/.codex/config.toml`:

```toml
[mcp_servers.lark-sheets]
command = "node"
args = ["/absolute/path/to/lark-sheets-mcp/src/server.mjs"]
env = { LARK_APP_ID = "cli_xxx", LARK_APP_SECRET = "xxx" }
```

Use `https://open.feishu.cn` as `LARK_DOMAIN` for Feishu (China).

**5. Test it.** Ask your agent: *"Check access to <sheet link>"*.

## Troubleshooting

| Error code | Fix |
|---|---|
| 91403 / 1310213 | The sheet is not shared with your app, or the app lacks edit access (see step 2) |
| 99991672 | Missing API scope. Add `sheets:spreadsheet`, then publish a new version |
| 99991663 | Expired token. Restart the MCP client |
| 90202 | Wrong range format. Use `TabName!A1:D10` |

## Security

Credentials are read only from environment variables. Never commit `.env` (it is in `.gitignore`). The app can only reach sheets you explicitly share with it.

---

## Bahasa Indonesia

Server MCP agar AI agent (Claude, Codex, dll.) bisa **membaca dan menulis Lark Sheets**, misalnya untuk update stok, tambah baris laporan, atau perbaiki rumus lewat perintah biasa.

**Cara pakai singkat:**
1. Buat custom app di Lark Developer Console, tambahkan scope `sheets:spreadsheet`, lalu publish.
2. Di setiap sheet: **••• → More → Add document app**, pilih app Anda, beri akses **Can edit**.
3. `npm install`, lalu masukkan `LARK_APP_ID` dan `LARK_APP_SECRET` di config MCP client (contoh di atas).
4. Tes dengan perintah: *"Check access to <link sheet>"*.

## License

MIT © 2026 Fathul Mubarok
