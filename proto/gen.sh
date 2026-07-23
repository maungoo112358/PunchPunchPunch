#!/usr/bin/env sh
# Regenerate the Go and TypeScript wire types from game.proto. The output is committed, so this only
# runs when the schema changes, the same way the golden trajectory file is generated then committed.
#
# Needs buf and protoc-gen-go on PATH (they live in ~/go/bin) and the client's node_modules installed
# for the TypeScript plugin. Runs from anywhere.
set -e
cd "$(dirname "$0")/.."
PATH="$HOME/go/bin:$PATH" buf generate proto --template proto/buf.gen.yaml
echo "generated: server/gen/gamepb/ and client/src/net/gen/"
