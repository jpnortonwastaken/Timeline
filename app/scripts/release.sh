#!/bin/bash
#
# Build, sign, notarize and staple a release of Timelime.
#
# Three separate things have to be true before macOS will run this app on
# somebody else's Mac, and they fail in different ways:
#
#   signed      - or Gatekeeper has nothing to check
#   notarized   - or Gatekeeper reports "malicious software" on first launch
#   stapled     - or it only passes while the user happens to be online
#
# The order below is forced, and it is not the obvious one. Tauri's dmg bundler
# *moves* the .app into the disk image and re-signs it on the way, so anything
# stapled beforehand is destroyed and `bundle/macos` is left empty. The app has
# to be notarized and stapled on its own first, and the disk image assembled
# around the stapled copy afterwards - which means two trips to Apple, one for
# each artifact, because a rebuilt image has a new hash and needs its own
# ticket.
#
# The Apple password never appears here. `notarytool` reads it from a keychain
# profile created once by hand, so it is not in this file, the environment, or
# the shell history:
#
#   xcrun notarytool store-credentials "timelime" \
#       --apple-id "<your apple id>" --team-id "9X945ZDXM2"
#
set -euo pipefail

IDENTITY="Developer ID Application: Jonathon Norton (9X945ZDXM2)"
PROFILE="timelime"
VOLNAME="Timelime"
# Universal, so this runs on Intel Macs too. Without it the build is arm64-only
# and an Intel user gets a baffling failure rather than a working app.
TARGET="universal-apple-darwin"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUNDLE="$HERE/src-tauri/target/$TARGET/release/bundle"
APP="$BUNDLE/macos/$VOLNAME.app"
WORK="$HERE/src-tauri/target/release-staging"
UPDATER_KEY="$HOME/.tauri/timelime.key"
KEYCHAIN_ITEM="timelime-updater-key"
REPO="jpnortonwastaken/Timelime"

step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
die() { printf '\n\033[31merror:\033[0m %s\n' "$1" >&2; exit 1; }
# Output is captured before being searched, never piped into `grep -q`. With
# `pipefail` set, grep exits at the first match, the writer takes SIGPIPE, and
# the pipeline reports failure - so the check fails exactly when it succeeds.
has() { case "$2" in *"$1"*) return 0 ;; *) return 1 ;; esac; }

VERSION="$(node -p "require('$HERE/src-tauri/tauri.conf.json').version")"
DMG="$BUNDLE/dmg/${VOLNAME}_${VERSION}_universal.dmg"

step "Checking prerequisites"
IDENTITIES="$(security find-identity -v -p codesigning 2>&1)"
has "$IDENTITY" "$IDENTITIES" \
  || die "No '$IDENTITY' in the keychain.
  Xcode > Settings > Accounts > Manage Certificates > + > Developer ID Application"
xcrun notarytool history --keychain-profile "$PROFILE" >/dev/null 2>&1 \
  || die "No notarytool keychain profile called '$PROFILE'. Create it with:
  xcrun notarytool store-credentials \"$PROFILE\" --apple-id \"<your apple id>\" --team-id \"9X945ZDXM2\""
TARGETS="$(rustup target list --installed 2>&1)"
for arch in aarch64-apple-darwin x86_64-apple-darwin; do
  has "$arch" "$TARGETS" || die "Rust target $arch is missing. Install it with:
  rustup target add $arch"
done
[ -f "$UPDATER_KEY" ] || die "No updater signing key at $UPDATER_KEY.
  Generate one with: npx tauri signer generate -w \"$UPDATER_KEY\""
security find-generic-password -a timelime -s "$KEYCHAIN_ITEM" >/dev/null 2>&1 \
  || die "No keychain item '$KEYCHAIN_ITEM' holding the updater key password."
echo "  certificate, notary credentials, updater key and both architectures present"

step "Running tests"
cd "$HERE"
npm test

step "Building and signing (both architectures)"
# Tauri signs when it sees this, and applies the hardened runtime with it -
# notarization rejects anything without that. Only the .app is built here; the
# disk image is assembled further down, from the stapled copy.
export APPLE_SIGNING_IDENTITY="$IDENTITY"
./node_modules/.bin/tauri build --target "$TARGET" --bundles app
[ -d "$APP" ] || die "No .app was produced at $APP"

step "Verifying the signature before submitting"
codesign --verify --deep --strict "$APP" || die "The signature is not valid"
SIGINFO="$(codesign -d --verbose=2 "$APP" 2>&1)"
has "flags=0x10000(runtime)" "$SIGINFO" \
  || die "Hardened runtime is missing - notarization would reject this"
ARCHS="$(lipo -archs "$APP/Contents/MacOS/timeline" 2>&1)"
has "x86_64" "$ARCHS" || die "Not a universal binary - got: $ARCHS"
has "arm64" "$ARCHS" || die "Not a universal binary - got: $ARCHS"
echo "  signed, hardened, universal ($ARCHS)"

step "Notarizing the app (Apple usually answers in 1-5 minutes)"
rm -rf "$WORK" && mkdir -p "$WORK"
# `ditto` is the only supported way to zip a bundle for notarization - it keeps
# the symlinks and extended attributes that a plain `zip` quietly flattens.
ditto -c -k --keepParent "$APP" "$WORK/app.zip"
xcrun notarytool submit "$WORK/app.zip" --keychain-profile "$PROFILE" --wait \
  || die "Notarization failed. For the reasons:
  xcrun notarytool log <submission-id> --keychain-profile \"$PROFILE\""
xcrun stapler staple "$APP"

step "Packaging the update artifact"
# Built from the *stapled* app, so an update lands already notarized. An update
# that has to phone Apple on first launch is one that fails on a bad network,
# in exactly the moment the app has just replaced itself.
UPDATE_TGZ="$BUNDLE/dmg/${VOLNAME}.app.tar.gz"
rm -f "$UPDATE_TGZ" "$UPDATE_TGZ.sig"
mkdir -p "$BUNDLE/dmg"
# COPYFILE_DISABLE stops macOS tar writing extended attributes as separate
# AppleDouble entries. Without it the archive gains a `._Timelime.app` sibling,
# and the updater tries to unpack that as the app bundle and fails - a download
# that completes and then quietly installs nothing.
( cd "$BUNDLE/macos" && COPYFILE_DISABLE=1 tar czf "$UPDATE_TGZ" "$VOLNAME.app" )
# Checked with python, not tar: macOS bsdtar transparently hides the
# AppleDouble entries it writes, so listing with the same tool that created the
# archive always reports a clean one. Tauri's Rust extractor sees them.
python3 - "$UPDATE_TGZ" <<'CHECK' || die "The archive contains AppleDouble entries - the updater cannot unpack it"
import sys, tarfile
bad = [m.name for m in tarfile.open(sys.argv[1])
       if m.name.split('/')[-1].startswith('._')]
if bad:
    print('  AppleDouble entries found:', bad[:3], file=sys.stderr)
sys.exit(1 if bad else 0)
CHECK
# The password is read straight out of the keychain into the environment of one
# command and nothing else. It is never echoed, never written, never in argv -
# `-p` would put it in the process list for any other user to read.
TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(security find-generic-password -a timelime -s "$KEYCHAIN_ITEM" -w)" \
TAURI_SIGNING_PRIVATE_KEY_PATH="$UPDATER_KEY" \
  ./node_modules/.bin/tauri signer sign "$UPDATE_TGZ" >/dev/null
[ -f "$UPDATE_TGZ.sig" ] || die "The update artifact was not signed"
echo "  $(basename "$UPDATE_TGZ") signed"

step "Building the disk image around the stapled app"
# Tauri writes `bundle_dmg.sh` and its applescript template only while running
# its own dmg bundler, and only into whichever target directory that ran in -
# so a universal build has neither. Borrow them from any previous build. The
# script finds its template two levels up, at share/create-dmg/support, so the
# pair has to keep that relationship.
mkdir -p "$BUNDLE/dmg"
DMGSCRIPT="$BUNDLE/dmg/bundle_dmg.sh"
if [ ! -f "$DMGSCRIPT" ]; then
  SRC="$(find "$HERE/src-tauri/target" -name bundle_dmg.sh -not -path "$BUNDLE/*" 2>/dev/null | head -1)"
  if [ -z "$SRC" ]; then
    # Nowhere to borrow from - a fresh clone, or a `cargo clean`, which takes
    # these with it. Tauri only writes them while running its own dmg bundler,
    # so run one against the default target: it lands in a different directory
    # and leaves the stapled universal app alone.
    echo "  no dmg tooling found; asking Tauri to produce it"
    ./node_modules/.bin/tauri build --bundles dmg >/dev/null 2>&1 || true
    SRC="$(find "$HERE/src-tauri/target" -name bundle_dmg.sh -not -path "$BUNDLE/*" 2>/dev/null | head -1)"
  fi
  [ -n "$SRC" ] || die "bundle_dmg.sh could not be produced. Try
  'npx tauri build --bundles dmg' by hand and read what it says."
  cp "$SRC" "$DMGSCRIPT"
  chmod +x "$DMGSCRIPT"
  SUPPORT="$(dirname "$(dirname "$SRC")")/share/create-dmg"
  [ -d "$SUPPORT" ] || die "create-dmg support files missing next to $SRC"
  mkdir -p "$BUNDLE/share"
  cp -R "$SUPPORT" "$BUNDLE/share/"
  echo "  borrowed the dmg tooling from $(dirname "$SRC")"
fi
[ -f "$BUNDLE/share/create-dmg/support/template.applescript" ] \
  || die "template.applescript is missing - the dmg script cannot lay out the window"
rm -f "$DMG"
mkdir -p "$WORK/stage"
cp -R "$APP" "$WORK/stage/"
( cd "$BUNDLE/dmg" && ./bundle_dmg.sh \
    --volname "$VOLNAME" \
    --icon "$VOLNAME.app" 180 170 \
    --app-drop-link 480 170 \
    --window-size 660 400 \
    --hide-extension "$VOLNAME.app" \
    "$DMG" "$WORK/stage" ) >/dev/null
[ -f "$DMG" ] || die "No .dmg was produced"
codesign --force --sign "$IDENTITY" --timestamp "$DMG"

step "Notarizing the disk image"
xcrun notarytool submit "$DMG" --keychain-profile "$PROFILE" --wait \
  || die "Notarization of the disk image failed"
xcrun stapler staple "$DMG"

step "Final check - exactly what Gatekeeper will do to a download"
# Assessed through the quarantine flag Safari stamps on downloads, because an
# un-quarantined file takes a more forgiving path and proves less.
CHECK="$WORK/downloaded.dmg"
cp "$DMG" "$CHECK"
xattr -w com.apple.quarantine "0081;00000000;Safari;" "$CHECK"
spctl --assess --type open --context context:primary-signature --verbose=2 "$CHECK" 2>&1 | sed 's/^/  /'
MP="$(hdiutil attach "$CHECK" -nobrowse -readonly | grep -o '/Volumes/.*' | head -1)"
spctl --assess --type execute --verbose=2 "$MP/$VOLNAME.app" 2>&1 | sed 's/^/  /'
xcrun stapler validate "$MP/$VOLNAME.app" 2>&1 | tail -1 | sed 's/^/  /'
lipo -archs "$MP/$VOLNAME.app/Contents/MacOS/timeline" | sed 's/^/  architectures: /'
hdiutil detach "$MP" -quiet
rm -rf "$WORK"

step "Writing latest.json"
# One universal artifact serves both architectures, so both keys point at it.
# The url has to be the final download location, not a local path - this file is
# what every installed copy reads to decide whether it is out of date.
MANIFEST="$BUNDLE/dmg/latest.json"
SIGNATURE="$(cat "$UPDATE_TGZ.sig")"
URL="https://github.com/$REPO/releases/download/v$VERSION/$(basename "$UPDATE_TGZ")"
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
cat > "$MANIFEST" <<JSON
{
  "version": "$VERSION",
  "pub_date": "$NOW",
  "platforms": {
    "darwin-aarch64": { "signature": "$SIGNATURE", "url": "$URL" },
    "darwin-x86_64":  { "signature": "$SIGNATURE", "url": "$URL" }
  }
}
JSON
node -e "JSON.parse(require('fs').readFileSync('$MANIFEST','utf8'))" \
  || die "latest.json is not valid JSON"
echo "  $MANIFEST"

printf '\n\033[32mBuilt and verified.\033[0m\n'
printf '  %s\n  %s\n  %s\n' "$DMG" "$UPDATE_TGZ" "$MANIFEST"
printf '\nPublish with:\n  gh release create v%s \\\n    "%s" \\\n    "%s" "%s" \\\n    --repo %s --title "v%s" --notes "..."\n\n' \
  "$VERSION" "$DMG" "$UPDATE_TGZ" "$MANIFEST" "$REPO" "$VERSION"
