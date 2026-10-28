// Games detection parsers: Steam library folders and app manifests, Epic
// .item manifests, and GOG registry rows — all shaped by pure functions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLibraryFolders, parseAcf, parseEpicManifest, shapeGog, shapeGame } from '../src/backend/games.js';
import { builtinById } from '../src/builtins.js';

const VDF = `"libraryfolders"
{
	"0"
	{
		"path"		"C:\\\\Program Files (x86)\\\\Steam"
		"label"		""
	}
	"1"
	{
		"path"		"D:\\\\SteamLibrary"
		"label"		"Games drive"
	}
}`;

const ACF = `"AppState"
{
	"appid"		"228980"
	"Universe"		"1"
	"name"		"Example Game II"
	"installdir"		"Example Game II"
}`;

test('parseLibraryFolders returns every library path, unescaped', () => {
  assert.deepEqual(parseLibraryFolders(VDF), ['C:\\Program Files (x86)\\Steam', 'D:\\SteamLibrary']);
  assert.deepEqual(parseLibraryFolders(''), []);
});

test('parseAcf reads the name and install folder', () => {
  const g = parseAcf(ACF);
  assert.equal(g.name, 'Example Game II');
  assert.equal(g.installdir, 'Example Game II');
  assert.equal(g.appid, '228980');
  assert.equal(parseAcf('"AppState" { "name" "No Folder" }'), null, 'a manifest without an install folder is not a game entry');
});

test('parseEpicManifest reads display name and location, and refuses junk', () => {
  const item = parseEpicManifest(JSON.stringify({ DisplayName: 'Space Game', InstallLocation: 'D:\\Epic\\SpaceGame', AppName: 'SpaceGame' }));
  assert.equal(item.name, 'Space Game');
  assert.equal(item.location, 'D:\\Epic\\SpaceGame');
  assert.equal(parseEpicManifest('not json'), null);
  assert.equal(parseEpicManifest('{"DisplayName":"No location"}'), null);
});

test('shapeGog and shapeGame normalize the three launchers to one row shape', () => {
  const gog = shapeGog({ key: 'HKLM\\SOFTWARE\\WOW6432Node\\GOG.com\\Games\\123', name: 'Old Classic', path: 'C:\\GOG Games\\Old Classic' });
  assert.equal(gog.launcher, 'GOG');
  assert.equal(gog.entryKind, 'key');
  const row = shapeGame(gog);
  assert.deepEqual(Object.keys(row).sort(), ['entryKind', 'entryPath', 'launcher', 'location', 'name', 'present', 'size']);
  assert.equal(shapeGog({ name: 'No path' }), null);
});

test('the Games built-in group matches launcher install folders only', () => {
  const rule = builtinById('games')[2];
  assert.equal(rule({ location: 'D:\\SteamLibrary\\steamapps\\common\\Example Game II' }), true);
  assert.equal(rule({ location: 'C:\\GOG Games\\Old Classic' }), true);
  assert.equal(rule({ location: 'C:\\Program Files\\Epic Games\\SpaceGame' }), true);
  assert.equal(rule({ location: 'C:\\Program Files\\Epic Games\\Launcher' }), false, 'the Epic launcher itself is not a game');
  assert.equal(rule({ location: 'C:\\Program Files\\Contoso Editor' }), false);
  assert.equal(rule({}), false);
});
