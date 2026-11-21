import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { albumArtist, cleanChapters, cleanSong, cleanSongs, fixCaps, isCompilation, folderName, safeName, trackFileName } from "./naming.ts";

// Real titles and channels from downloaded playlists.
const cases: [title: string, channel: string, artist: string, song: string][] = [
  ["Luli Pampín - CAMINO POR LA SELVA🙊🐍🦁🐘 - Official Video", "Luli Pampín", "Luli Pampín", "Camino por la Selva"],
  ["FAMILIA DEDO FELIZ - Luli Pampín🖐👩👨👧👦👶 - Official Video", "Luli Pampín", "Luli Pampín", "Familia Dedo Feliz"],
  ["Luli Pampín - EL ENFADO QUE YO SIENTO (Official Video)", "Luli Pampín", "Luli Pampín", "El Enfado Que Yo Siento"],
  ["Luli Pampín - MAESTROS SENSEI 🧑‍🏫 👨🏻‍🏫 🩷(Official Video)", "Luli Pampín", "Luli Pampín", "Maestros Sensei"],
  ["Luli Pampín - HICKORY DICKORY DOCK 🕰 🦁🐻🐍🐸🦜🐭#hickory", "Luli Pampín", "Luli Pampín", "Hickory Dickory Dock"],
  ["Luli Pampín - FAMILIA DEDO ✋🤚 (VOCALES) A-E-I-O-U", "Luli Pampín", "Luli Pampín", "Familia Dedo (Vocales) A-E-I-O-U"],
  ["Luli & Teotronico - 🏡​ ​🤖​💖​YO TENGO UNA CASITA 🎹 #robot", "Luli Pampín", "Luli & Teotronico", "Yo Tengo una Casita"],
  ["TOPA- MARIPOSITA 🦋 Official Video", "TOPA", "TOPA", "Mariposita"],
  ["TOPA - HOCKY POCKY - Official Video 🕺🏻", "TOPA", "TOPA", "Hocky Pocky"],
  ["Topa - CON MI TRACTOR (Official Video)", "TOPA", "TOPA", "Con Mi Tractor"],
  ["TOPA 🤡 EL PAYASITO (Official Video)", "TOPA", "TOPA", "El Payasito"],
  ["Diego Topa - El viajero (Official Sing-Along Video)", "TOPA", "Diego Topa", "El viajero"],
  ["TOPA - SOY UNA TAZA ft. La Brigata Canterina", "TOPA", "TOPA", "Soy una Taza ft. La Brigata Canterina"],
  ["LULI PAMPIN y DIEGO TOPA - El tren de las vocales (dueto)", "TOPA", "LULI PAMPIN y DIEGO TOPA", "El tren de las vocales (dueto)"],
  ["Topa y Daisy Dot 🇪🇸 Con los animales 🇬🇧 Playing with the Animals", "TOPA", "Topa y Daisy Dot", "Con los animales Playing with the Animals"],
  ["PEQUEÑO PEZ-  PEZ TIBURÓN. Juego de Manos..", "Pequeño Pez", "Pequeño Pez", "Pez Tiburón. Juego de Manos"],
  ["PEQUEÑO PEZ  - ME MUEVO (Canción para despertar el cuerpo)", "Pequeño Pez", "Pequeño Pez", "Me Muevo (Canción para despertar el cuerpo)"],
  ["Canción de la vacuna - Canciones Para Soñar | Petits Habitants", "Petits Habitants", "Petits Habitants", "Canción de la vacuna"],
  ["La Patita Lulú - Las Canciones del Zoo 2 | El Reino Infantil", "El Reino Infantil", "El Reino Infantil", "La Patita Lulú"],
  ["Las Mañanitas 🎂 Canción de Cumpleaños | BICHIKIDS | El Reino Infantil", "El Reino Infantil", "El Reino Infantil", "Las Mañanitas Canción de Cumpleaños"],
  ["Queen - Bohemian Rhapsody (Official Video Remastered)", "Queen Official", "Queen", "Bohemian Rhapsody"],
  ["Bohemian Rhapsody", "Queen - Topic", "Queen", "Bohemian Rhapsody"],
];

describe("cleanSong", () => {
  for (const [title, channel, artist, song] of cases) {
    it(title, () => {
      assert.deepEqual(cleanSong({ title, channel }), { artist, title: song });
    });
  }

  it("prefers YouTube Music metadata", () => {
    assert.deepEqual(
      cleanSong({ title: "anything", channel: "x", track: "Ganas de Aplaudir", artists: ["Topa", "Luli Pampín"] }),
      { artist: "Topa & Luli Pampín", title: "Ganas de Aplaudir" },
    );
  });

  it("falls back to an unknown artist", () => {
    assert.deepEqual(cleanSong({ title: "Some Song" }), { artist: "Unknown Artist", title: "Some Song" });
  });
});

describe("cleanSongs", () => {
  it("reads ambiguous titles like the rest of a song-first playlist", () => {
    const channel = "El Reino Infantil";
    const names = cleanSongs([
      { title: "La Patita Lulú - Las Canciones del Zoo 2 | El Reino Infantil", channel },
      { title: "Soy Una Taza - Paco El Marinero | El Reino Infantil", channel },
      { title: "La Vaca Lola - Canciones de La Granja de Zenón 2", channel },
    ]);
    assert.deepEqual(names[2], { artist: "El Reino Infantil", title: "La Vaca Lola" });
  });

  it("keeps Artist - Song in an artist-first playlist", () => {
    const channel = "Luli Pampín";
    const names = cleanSongs([
      { title: "Luli Pampín - CRACK EL HUEVO 🥚 🪺 - Official Video", channel },
      { title: "Luli & Teotronico - YO TENGO UNA CASITA", channel },
    ]);
    assert.deepEqual(names[1], { artist: "Luli & Teotronico", title: "Yo Tengo una Casita" });
  });
});

describe("fixCaps", () => {
  it("converts a long shouted first word", () => assert.equal(fixCaps("CHAU (Canción para despedirse)"), "Chau (Canción para despedirse)"));
  it("lowercases single-letter connectors", () => assert.equal(fixCaps("SUBE Y BAJA"), "Sube y Baja"));
  it("keeps letters that aren't connectors", () => assert.equal(fixCaps("FAMILIA DEDO A-E-I-O-U"), "Familia Dedo A-E-I-O-U"));
  it("keeps single acronyms", () => assert.equal(fixCaps("Cantamos con ABC"), "Cantamos con ABC"));
  it("keeps a short all-caps word", () => assert.equal(fixCaps("ABC"), "ABC"));
  it("keeps connectors lowercase except first", () => assert.equal(fixCaps("LA VACA DE LA GRANJA"), "La Vaca de la Granja"));
});

describe("file names", () => {
  const name = { artist: "AC/DC", title: "Back: In Black?" };

  it("replaces characters filesystems reject", () => {
    assert.equal(trackFileName(name), "AC⧸DC - Back： In Black？.mp3");
  });

  it("pads track numbers to at least two digits", () => {
    assert.equal(trackFileName(name, 2, 5), "02 - AC⧸DC - Back： In Black？.mp3");
    assert.equal(trackFileName(name, 7, 120), "007 - AC⧸DC - Back： In Black？.mp3");
  });

  it("limits the length", () => {
    assert.equal(Array.from(safeName("a".repeat(400))).length, 150);
    assert.equal(safeName("CON"), "CON_");
    assert.equal(safeName("nul."), "nul_");
    assert.equal(safeName("Console"), "Console");
  });

  it("cleans playlist folder names", () => {
    assert.equal(
      folderName("El Reino Infantil ⭐ 15 Años Creciendo Juntos | Canciones Infantiles 🪄"),
      "El Reino Infantil 15 Años Creciendo Juntos - Canciones Infantiles",
    );
  });
});

describe("albumArtist", () => {
  it("uses the only artist", () => assert.equal(albumArtist([{ artist: "A", title: "1" }, { artist: "A", title: "2" }]), "A"));
  it("uses Various Artists for mixed playlists", () =>
    assert.equal(albumArtist([{ artist: "A", title: "1" }, { artist: "B", title: "2" }]), "Various Artists"));
});

describe("cleanChapters", () => {
  // Chapters of a real Plim Plim compilation.
  const titles = [
    "Saco una manito (Para Bebés)",
    "Las ruedas del autobus (Para Bebés)",
    "Sonrisas (ara Bebés)",
    "A Dormir - Extendida (Para Bebés)",
    "A Dormir (Feat Arafa)",
    "LOS POLLITOS DICEN 🐥 (Para Bebés)",
  ];
  const names = cleanChapters(titles, "El Payaso Plim Plim");

  it("uses the channel as the artist", () => assert.ok(names.every((name) => name.artist === "El Payaso Plim Plim")));

  it("removes text shared by most chapters and keeps the rest", () => {
    assert.deepEqual(
      names.map((name) => name.title),
      ["Saco una manito", "Las ruedas del autobus", "Sonrisas (ara Bebés)", "A Dormir - Extendida", "A Dormir (Feat Arafa)", "Los Pollitos Dicen"],
    );
  });
});

describe("isCompilation", () => {
  it("needs 3+ chapters and 10+ minutes", () => {
    assert.equal(isCompilation(20, 4723), true);
    assert.equal(isCompilation(2, 4723), false);
    assert.equal(isCompilation(4, 240), false);
  });
});
