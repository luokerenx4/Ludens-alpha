#!/bin/bash
set -euo pipefail
provider_dir=$(cd "$(dirname "$0")" && pwd)
repo_dir=$(cd "$provider_dir/../../../.." && pwd)
# Keep downloaded source, SDK and published bundles outside the code checkout.
artifact_dir="$repo_dir/../artifacts/switch"
source_dir="$artifact_dir/ryubing-canary-source"
revision=475615f0431b4995b03c930c5089d20f6f3570e0
sdk="${RSA_DOTNET:-$artifact_dir/dotnet/dotnet}"

# Install a .NET 10 SDK separately, or point RSA_DOTNET at an existing dotnet.
test -x "$sdk"
if [ ! -d "$source_dir/.git" ]; then
  git clone --depth 1 --branch Canary-1.3.351 https://starforgejo.dev/archive/Ryubing.git "$source_dir"
fi
test "$(git -C "$source_dir" rev-parse HEAD)" = "$revision"
if git -C "$source_dir" apply --check "$provider_dir/ryubing.patch" 2>/dev/null; then
  git -C "$source_dir" apply "$provider_dir/ryubing.patch"
else
  git -C "$source_dir" apply --reverse --check "$provider_dir/ryubing.patch"
fi
cp "$provider_dir/RsaBridge.cs" "$source_dir/src/Ryujinx/Systems/RsaBridge.cs"
export DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1
"$sdk" publish "$source_dir/src/Ryujinx/Ryujinx.csproj" -c Release -r osx-arm64 \
  --self-contained true -m:2 -p:Version=1.3.351-rsa.3 -p:SourceRevisionId=475615f04 \
  -o "$artifact_dir/ryubing-publish"

cd "$source_dir/distribution/macos"
./create_app_bundle.sh "$artifact_dir/ryubing-publish" "$artifact_dir/ryubing-build" "$PWD/entitlements.xml"
app="$artifact_dir/ryubing-build/Ryujinx.app"
python3 - "$app/Contents/Info.plist" <<'PY'
import plistlib, sys
path = sys.argv[1]
with open(path, 'rb') as file:
    info = plistlib.load(file)
info.update(CFBundleIdentifier='dev.playness.Ryubing', CFBundleName='Ryubing',
            CFBundleDisplayName='Ryubing',
            CFBundleShortVersionString='1.3.351', CFBundleVersion='1.3.351',
            CFBundleLongVersionString='1.3.351-rsa.3-475615f04')
with open(path, 'wb') as file:
    plistlib.dump(info, file)
PY
codesign --entitlements "$PWD/entitlements.xml" --force --sign - "$app"
codesign --verify --deep --strict "$app"
echo "Built $app"
