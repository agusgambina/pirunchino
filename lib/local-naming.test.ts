import assert from "node:assert/strict";
import { beforeEach, describe, it, mock } from "node:test";
import { type AiSong, improveNames, isGrounded, ollamaUrl, polish, resetLocalNaming } from "./local-naming.ts";

const song = (id: string, youtubeTitle: string, channel: string, artist: string, title: string): AiSong => ({
  id,
  youtubeTitle,
  channel,
  ruleBasedGuess: { artist, title },
});

// The playlist-level rule in cleanSongs reads this title as Song - Series.
const vaca = song("vaca", "La Vaca Lola - Canciones de La Granja de Zenón 2", "El Reino Infantil", "El Reino Infantil", "La Vaca Lola");
const topa = song("topa", "TOPA 🤡 EL PAYASITO (Official Video)", "TOPA", "TOPA", "El Payasito");

/** A fetch stub that answers like Ollama's /api/chat. */
function ollamaReturning(songs: unknown[]): typeof fetch {
  return (async () => Response.json({ message: { content: JSON.stringify({ songs }) } })) as typeof fetch;
}

beforeEach(() => resetLocalNaming());

describe("isGrounded", () => {
  it("accepts names rewritten from the YouTube text", () => {
    assert.ok(isGrounded({ artist: "El Reino Infantil", title: "La vaca Lola" }, vaca));
    assert.ok(isGrounded({ artist: "Topa", title: "El payasito" }, topa));
  });

  it("accepts added accents", () => {
    const luli = song("x", "LULI PAMPIN - CRACK EL HUEVO", "Luli Pampin", "LULI PAMPIN", "Crack el Huevo");
    assert.ok(isGrounded({ artist: "Luli Pampín", title: "Crack el huevo" }, luli));
  });

  it("rejects garbled words and titles that repeat the artist", () => {
    const taza = song("t", "TOPA - SOY UNA TAZA ft. La Brigata Canterina", "TOPA", "TOPA", "Soy una Taza");
    assert.equal(isGrounded({ artist: "TOPA", title: "So y una taza" }, taza), false);
    const pez = song("p", "PEQUEÑO PEZ - CANCIÓN DE BIENVENIDA.", "Pequeño Pez", "Pequeño Pez", "Canción de Bienvenida");
    assert.equal(isGrounded({ artist: "Pequeño Pez", title: "Pequeño pez" }, pez), false);
  });

  it("rejects the title copied into the artist, and repeated artists", () => {
    const mariposita = song("m", "TOPA- MARIPOSITA 🦋 Official Video", "TOPA", "TOPA", "Mariposita");
    assert.equal(isGrounded({ artist: "TOPA & Mariposita", title: "Mariposita" }, mariposita), false);
    const loro = song("l", "LULI PAMPIN Y DIEGO TOPA - El loro Wito (dueto)", "TOPA", "LULI PAMPIN Y DIEGO TOPA", "El loro Wito (dueto)");
    assert.equal(isGrounded({ artist: "TOPA & DIEGO TOPA", title: "El loro Wito" }, loro), false);
    assert.ok(isGrounded({ artist: "Luli Pampin & Diego Topa", title: "El loro Wito" }, loro));
    const abc = song("a", "Luli Pampín - ABC - La canción del Alfabeto (feat Lupadino)", "Luli Pampín", "Luli Pampín", "Abc - La canción del Alfabeto");
    assert.equal(isGrounded({ artist: "Luli Pampín & Abc", title: "Abc - La canción del Alfabeto" }, abc), false);
  });

  it("keeps every performer the rules found", () => {
    const folk = song("f", "Leda y María / Canciones del tiempo de Maricastaña - Tres hojitas", "Folklore", "Leda y María", "Tres hojitas");
    assert.equal(isGrounded({ artist: "Folklore", title: "Tres hojitas" }, folk), false);
    const reino = song("r", "Con la A A A | BICHIKIDS Canciones Infantiles", "El Reino Infantil", "El Reino Infantil", "Con la A A A");
    assert.equal(isGrounded({ artist: "Bichikids", title: "Con la A A A" }, reino), false);
    const walsh = song("w", "Maria Elena Walsh, Leda Valladares - Vidalita", "Maria Elena Walsh", "Maria Elena Walsh, Leda Valladares", "Vidalita");
    assert.equal(isGrounded({ artist: "Maria Elena Walsh", title: "Vidalita" }, walsh), false);
    assert.ok(isGrounded({ artist: "Maria Elena Walsh & Leda Valladares", title: "Vidalita" }, walsh));
    const brigata = song("b", "TOPA - SOY UNA TAZA ft. La Brigata Canterina", "TOPA", "TOPA", "Soy una Taza ft. La Brigata Canterina");
    assert.ok(isGrounded({ artist: "TOPA & La Brigata Canterina", title: "Soy una taza" }, brigata));
  });

  it("doesn't take songwriters from the description as artists", () => {
    const mane = { ...song("x", "TOPA - LA MANÉ (Official Video)", "TOPA", "TOPA", "La Mané"), description: "LA MANÉ (A. Mantovani - D. Topa)" };
    assert.equal(isGrounded({ artist: "A. Mantovani & D. TOPA", title: "La Mané" }, mane), false);
  });

  it("only takes title words from the YouTube title", () => {
    const dedo = { ...song("d", "Luli Pampín - FAMILIA DEDO (Medios de transporte)", "Luli Pampín", "Luli Pampín", "Familia Dedo"), description: "Familia dedo feliz y más canciones" };
    assert.equal(isGrounded({ artist: "Luli Pampín", title: "Familia Dedo feliz" }, dedo), false);
  });

  it("rejects invented words", () => {
    assert.equal(isGrounded({ artist: "El Reino Infantil", title: "La vaca feliz" }, vaca), false);
    assert.equal(isGrounded({ artist: "Diego Topa", title: "El payasito" }, topa), false);
  });
});

describe("polish", () => {
  const mananitas = song("m", "Las Mañanitas 🎂 Canción de Cumpleaños | BICHIKIDS", "El Reino Infantil", "El Reino Infantil", "Las Mañanitas Canción de Cumpleaños");

  it("takes spelling and casing from the rule-based name", () => {
    assert.deepEqual(polish({ artist: "el reino infantil", title: "las mananitas" }, mananitas), {
      artist: "El Reino Infantil",
      title: "Las Mañanitas",
    });
  });

  it("restores accents for words only in the YouTube text", () => {
    const pez = song("p", "PEQUEÑO PEZ - FONDO DE LA MAR. Juego de manos. Memoria y Coordinación", "Pequeño Pez", "Pequeño Pez", "Fondo de la Mar");
    assert.equal(polish({ artist: "Pequeño Pez", title: "Fondo de la mar y coordinacion" }, pez).title, "Fondo de la Mar y coordinación");
  });
});

describe("ollamaUrl", () => {
  it("adds the scheme when OLLAMA_HOST leaves it out", () => {
    assert.equal(ollamaUrl(undefined), "http://localhost:11434");
    assert.equal(ollamaUrl("0.0.0.0:11434"), "http://0.0.0.0:11434");
    assert.equal(ollamaUrl("https://ollama.example.com/"), "https://ollama.example.com");
  });
});

describe("improveNames", () => {
  it("keeps grounded answers and drops the rest", async () => {
    const names = await improveNames([vaca, topa], "Playlist", {
      fetch: ollamaReturning([
        { id: "vaca", artist: "El Reino Infantil", title: "La vaca Lola" },
        { id: "topa", artist: "Topa", title: "El payaso feliz" },
        { id: "unknown", artist: "A", title: "B" },
      ]),
    });
    assert.deepEqual([...names], [["vaca", { artist: "El Reino Infantil", title: "La Vaca Lola" }]]);
  });

  it("ignores empty fields and unreadable answers", async () => {
    const empty = await improveNames([vaca], undefined, { fetch: ollamaReturning([{ id: "vaca", artist: "", title: "La vaca Lola" }]) });
    assert.equal(empty.size, 0);

    const garbage = (async () => Response.json({ message: { content: "not json" } })) as typeof fetch;
    assert.equal((await improveNames([vaca], undefined, { fetch: garbage })).size, 0);
  });

  it("falls back once when Ollama isn't running", async () => {
    const warn = mock.method(console, "warn", () => {});
    const refused = mock.fn(async () => {
      throw new TypeError("fetch failed");
    });
    try {
      assert.equal((await improveNames([vaca], undefined, { fetch: refused as typeof fetch })).size, 0);
      assert.equal((await improveNames([topa], undefined, { fetch: refused as typeof fetch })).size, 0);
      assert.equal(refused.mock.callCount(), 1);
      assert.equal(warn.mock.callCount(), 1);
      assert.match(String(warn.mock.calls[0].arguments[0]), /Ollama isn't running/);
    } finally {
      warn.mock.restore();
    }
  });

  it("explains a missing model", async () => {
    const warn = mock.method(console, "warn", () => {});
    try {
      await improveNames([vaca], undefined, { model: "tiny:1b", fetch: (async () => new Response("", { status: 404 })) as typeof fetch });
      assert.match(String(warn.mock.calls[0].arguments[0]), /ollama pull tiny:1b/);
    } finally {
      warn.mock.restore();
    }
  });
});
