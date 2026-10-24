#!/usr/bin/env bash
# No-leak proof for `npm run doctor` (scripts/doctor.ts).
#
# With a real-looking key in OPENROUTER_API_KEY, the doctor must exit 0, report
# that setting as exactly `set`, and print no part of the value on stdout or
# stderr — not the full value, not any prefix down to 3 characters, not any
# 8+ character interior substring, not masked, not inside an error message or
# stack trace. Runs with the key unset and with the empty string must report
# `missing`.
#
# Re-runnable proof: exits 0 only when every check holds; the first failure
# exits 1. Run from the repository root (it cds there itself).
#
# `scripts/doctor-no-leak-proof.sh --self-test` runs the negative cases instead:
# the leak check must fire on the full value, appending a short prefix (`sk-or`,
# `sk-`) to a captured output file must make the proof exit 1, and a doctor that
# exits non-zero must make the proof exit 1.
#
# `scripts/doctor-no-leak-proof.sh --sweep` runs the hostile-value sweep: the
# list of reported settings is derived from doctor's own output, and every
# setting is set to its own unique hostile marker value (shell/regex/log
# metacharacters plus a long fixed token; the setting name is embedded so a hit
# names the culprit). One run per setting, one run with every marker set at
# once, one run covering the GitHub App credential group through a hostile
# dataDir/secrets/github-app.json, and one forced failure path (PUBLIC_URL,
# src/config.ts parses it with new URL() while loading). For every run the
# complete stdout+stderr is searched for each marker as a fixed string; the
# sweep exits 0 only when no marker appears anywhere. The only place a marker
# may appear is on one of the identifier lines doctor intentionally echoes
# (`agent model:` / `foreman model:` / `reviewer model:` / `coder model:` /
# `data dir:`) — required behaviour: the report shows the model identifiers in
# use, so CODER_MODEL's marker legitimately appears exactly there and nowhere
# else. Any other occurrence prints `LEAK: '<marker>' found in <file>` and the
# sweep exits 1. A literal newline is deliberately NOT in the marker (it breaks
# env passing in the npm/node invocation); the two-byte sequence `\n` is used
# instead. Try to defeat that guarantee with `--sweep --self-test`: a hostile
# marker appended to a captured stdout line must make the sweep exit 1 while
# naming the culprit setting.

VALUE="sk-or-doctor-test-123"

fail() { echo "PROOF FAILED: $*"; exit 1; }

root="$(git rev-parse --show-toplevel 2>/dev/null || echo "$(dirname "$0")/..")"
cd "$root" || fail "cannot find repository root"

# Needles: EVERY prefix of the value of length >= 3 (catches short-prefix
# masking bugs such as printing value.slice(0, 5) + "..."), plus every
# 8-character window that is not already a prefix (catches interior
# substrings; prefixes of length >= 8 come from the first loop). Longest
# first, so the LEAK message names the longest leaking substring.
needles=()
for ((l = ${#VALUE}; l >= 3; l--)); do needles+=("${VALUE:0:l}"); done
for ((i = 1; i + 8 <= ${#VALUE}; i++)); do needles+=("${VALUE:i:8}"); done

# Returns 0 only when no needle appears in the file; prints `LEAK: ...` and
# returns 1 on the first hit.
leak_free() {
	local f="$1" needle
	for needle in "${needles[@]}"; do
		if grep -qF -- "$needle" "$f"; then
			echo "LEAK: '$needle' found in $f"
			return 1
		fi
	done
	return 0
}

check_no_leak() { # <file>: print the leak and hard-exit the proof on a hit
	leak_free "$1" || exit 1
}

# The real proof. Exit 0 only when everything holds.
run_proof() {
	local doctor status out mode
	if [ "$#" -gt 0 ]; then doctor=("$@"); else doctor=(npm run doctor); fi

	dir="$(mktemp -d)"

	# 1) Run with the key set; capture both streams and the exit code.
	OPENROUTER_API_KEY="$VALUE" "${doctor[@]}" >"$dir/out.txt" 2>"$dir/err.txt"
	status=$?
	echo "exit=$status"
	[ "$status" -eq 0 ] || fail "npm run doctor exited $status"

	# Self-test hook: append $PROOF_INJECT to a copy of the captured stdout so
	# the checks below see a leak and must fail the proof (used by --self-test).
	out="$dir/out.txt"
	if [ -n "${PROOF_INJECT:-}" ]; then
		cp "$dir/out.txt" "$dir/out-injected.txt"
		printf '%s\n' "$PROOF_INJECT" >>"$dir/out-injected.txt"
		out="$dir/out-injected.txt"
	fi

	check_no_leak "$out"
	check_no_leak "$dir/err.txt"
	grep -qxF "OPENROUTER_API_KEY: set" "$out" ||
		fail "report does not say exactly 'OPENROUTER_API_KEY: set' (stdout above)"
	grep -qF "OPENROUTER_API_KEY: missing" "$out" &&
		fail "report says 'missing' while the key is set"

	# 2) Key unset, and 3) key empty: the setting must be reported as `missing`.
	for mode in unset empty; do
		if [ "$mode" = unset ]; then
			env -u OPENROUTER_API_KEY "${doctor[@]}" >"$dir/out-$mode.txt" 2>"$dir/err-$mode.txt"
		else
			OPENROUTER_API_KEY= "${doctor[@]}" >"$dir/out-$mode.txt" 2>"$dir/err-$mode.txt"
		fi
		status=$?
		[ "$status" -eq 0 ] || fail "npm run doctor ($mode key) exited $status"
		check_no_leak "$dir/out-$mode.txt"
		check_no_leak "$dir/err-$mode.txt"
		grep -qxF "OPENROUTER_API_KEY: missing" "$dir/out-$mode.txt" ||
			fail "report does not say exactly 'OPENROUTER_API_KEY: missing' with the key $mode"
	done

	rm -rf "$dir"
}

# ── Hostile-value sweep ─────────────────────────────────────────────────────

# One hostile marker per setting: quote/backslash shell, regex and log-format
# metacharacters plus a long fixed token, prefixed with the setting name so a
# hit names the culprit. Deterministic, so the proof is re-runnable. No literal
# newline (it breaks env passing in the npm/node invocation; two-byte `\n`
# instead — the marker is still quote/backslash-hostile).
sweep_marker() { # <NAME>
	local q="'"
	printf 'MARK_%s_%s' "$1" "${q}\\\"\$(){}[]|;&*?%\`\\n x9f3a7b2c1d4e5f6a7b8c9d0e"
}

# Assert that a marker does not appear in a captured output file, allowing for
# exactly the occurrences doctor prints by design: the identifier/echo lines
# (`agent model:`, `foreman model:`, `reviewer model:`, `coder model:`,
# `data dir:` — lowercase labels; the values there are identifiers, not
# secrets, and the report must show the model ids in use, so CODER_MODEL's
# marker legitimately appears on `coder model:` and nowhere else). Every other
# occurrence — and every occurrence in stderr — prints
# `LEAK: '<marker>' found in <file>` and exits 1. The setting name is embedded
# in the marker, so a hit names the culprit.
sweep_check_file() { # <file> <marker> → 0 absent; 2 only on by-design echo lines; LEAK+exit 1 otherwise
	local file="$1" m="$2"
	if grep -qF -- "$m" "$file"; then
		grep -F -- "$m" "$file" | grep -vE '^[a-z][a-z ]*(model|dir): ' >"$file.hits"
		if [ -s "$file.hits" ]; then
			while IFS= read -r line; do
				echo "LEAK: '$m' found in $file: $line"
			done <"$file.hits"
			exit 1
		fi
		return 2 # marker appears only on the by-design echo lines
	fi
	return 0
}

# Same contract as sweep_check_file, but "only on the echo lines" (2) is only
# acceptable for CODER_MODEL — the report must show the coder model id in use,
# so its value legitimately appears on the single `coder model:` line, and
# nowhere else. Any other setting showing up on an echo line fails the sweep.
sweep_assert_absent() { # <file> <marker> <setting-name>
	local rc
	sweep_check_file "$1" "$2"
	rc=$?
	[ "$rc" -eq 0 ] && return 0
	[ "$rc" -eq 2 ] || exit 1
	[ "$3" = "CODER_MODEL" ] || fail "sweep: marker of $3 appeared on an echo line, which is only by-design for CODER_MODEL"
	echo "  (note: $3 value present only on the by-design 'coder model:' echo line in $1)"
	return 0
}

hostile_sweep() {
	local tmp status name m rc
	tmp="$(mktemp -d)" || fail "sweep: mktemp failed"
	trap 'rm -rf "$tmp"' EXIT

	# The sweep follows doctor's own output (not a text range over src/config.ts),
	# so it stays correct if the config block is restructured.
	local settings=() unset_args=()
	while IFS= read -r name; do
		settings+=("$name")
		unset_args+=(-u "$name")
	done < <(npm run doctor 2>/dev/null | grep -E '^[A-Z_]+: ' | sed 's/:.*//')
	[ "${#settings[@]}" -gt 0 ] || fail "sweep: derived no reported settings from npm run doctor"
	echo "sweep: derived ${#settings[@]} reported settings from npm run doctor: ${settings[*]}"

	# (1) One run per setting: exactly one hostile marker in that variable, all
	# other reported settings unset. Each marker must be absent from stdout and
	# stderr, except for the single by-design identifier echo (CODER_MODEL on
	# `coder model:`).
	local had_error_path=0
	for name in "${settings[@]}"; do
		m="$(sweep_marker "$name")"
		env "${unset_args[@]}" "$name=$m" npm run doctor >"$tmp/out-$name" 2>"$tmp/err-$name"
		status=$?
		# Self-test hook (--sweep --self-test): append the marker to a plain
		# stdout line so the checks below must catch it.
		if [ -n "${SWEEP_INJECT:-}" ] && [ "$name" = "${SWEEP_INJECT_SETTING:-OPENROUTER_API_KEY}" ]; then
			printf 'tampered line: %s\n' "$m" >>"$tmp/out-$name"
		fi
		sweep_check_file "$tmp/err-$name" "$m" || exit 1
		sweep_check_file "$tmp/out-$name" "$m"
		rc=$?
		if [ "$rc" -eq 0 ]; then
			if [ "$status" -eq 0 ]; then
				echo "ok $name no leak (doctor exit 0)"
			elif [ "$name" = "PUBLIC_URL" ]; then
				# The one reachable failure path: src/config.ts parses PUBLIC_URL
				# with new URL() while loading (the auth relying-party id), so a
				# URL-hostile marker makes the config import throw. doctor must
				# fail closed: exit 1, `doctor: report failed` only, no marker,
				# no stack trace carrying values.
				grep -qxF 'doctor: report failed' "$tmp/err-$name" ||
					fail "sweep: hostile $name made doctor exit $status but stderr is not the clean 'doctor: report failed' notice"
				grep -q '    at ' "$tmp/err-$name" && fail "sweep: the failed $name run printed a stack trace (values may be inside it)"
				grep -qE '^(agent|coder) model:' "$tmp/out-$name" &&
					fail "sweep: the failed $name run printed part of the report block"
				had_error_path=1
				echo "ok $name no leak (error path: config rejected the value, doctor exit 1, stderr is only 'doctor: report failed', no marker, no stack trace)"
			else
				fail "sweep: npm run doctor with a hostile marker in $name exited $status (unexpected failure path)"
			fi
		elif [ "$rc" -eq 2 ] && [ "$name" = "CODER_MODEL" ]; then
			[ "$status" -eq 0 ] || fail "sweep: hostile $name made doctor exit $status"
			echo "ok $name no leak (value echoed only on the by-design 'coder model:' identifier line — the report must show the coder model id; never printed as the setting's own presence, nor in stderr, nor anywhere else)"
		elif [ "$rc" -eq 2 ]; then
			fail "sweep: marker of $name appeared on an identifier echo line, which is by-design only for CODER_MODEL"
		fi
	done
	[ "$had_error_path" -eq 1 ] || fail "sweep: no reachable error path was exercised (expected PUBLIC_URL)"

	# (2) One run with every reported setting holding its own marker at once.
	# With the raw markers the config import throws on PUBLIC_URL first, so
	# doctor fails closed; afterwards a second combined run gives PUBLIC_URL a
	# URL-shaped hostile marker (same metacharacters inside the query string)
	# so the full report prints and every presence line must say `set` — while
	# still showing no value.
	local pairs_raw=() pairs_url=()
	for name in "${settings[@]}"; do
		pairs_raw+=("$name=$(sweep_marker "$name")")
		if [ "$name" = "PUBLIC_URL" ]; then
			pairs_url+=("$name=https://h.example/?q=$(sweep_marker "$name")")
		else
			pairs_url+=("$name=$(sweep_marker "$name")")
		fi
	done

	# (2a) All raw markers at once: doctor must fail closed, value-free.
	env "${unset_args[@]}" "${pairs_raw[@]}" npm run doctor >"$tmp/out-rawall" 2>"$tmp/err-rawall"
	status=$?
	grep -qxF 'doctor: report failed' "$tmp/err-rawall" || fail "sweep: combined raw-hostile run exited $status without the clean 'doctor: report failed' notice"
	grep -q '    at ' "$tmp/err-rawall" && fail "sweep: combined raw-hostile run printed a stack trace"
	[ "$((status))" -eq 1 ] || fail "sweep: expected the combined raw-hostile run to fail closed with exit 1, got $status"
	for name in "${settings[@]}"; do
		sweep_assert_absent "$tmp/err-rawall" "$(sweep_marker "$name")" "$name" || exit 1
		sweep_assert_absent "$tmp/out-rawall" "$(sweep_marker "$name")" "$name" || exit 1
	done
	echo "ok combined (all ${#settings[@]} hostile markers at once, raw): doctor failed closed (exit 1, stderr is only 'doctor: report failed'), zero markers in stdout+stderr"

	# (2b) All markers at once with a parseable hostile PUBLIC_URL: the full
	# report prints; every derived setting must be reported as `set`.
	env "${unset_args[@]}" "${pairs_url[@]}" npm run doctor >"$tmp/out-urlall" 2>"$tmp/err-urlall"
	status=$?
	[ "$status" -eq 0 ] || fail "sweep: combined URL-shaped run exited $status (expected 0 with all markers set at once)"
	for name in "${settings[@]}"; do
		sweep_assert_absent "$tmp/err-urlall" "$(sweep_marker "$name")" "$name" || exit 1
		sweep_assert_absent "$tmp/out-urlall" "$(sweep_marker "$name")" "$name" || exit 1
		grep -qxF "$name: set" "$tmp/out-urlall" ||
			fail "sweep: combined run does not report exactly '$name: set'"
	done
	echo "ok combined (all ${#settings[@]} hostile markers at once, URL-shaped PUBLIC_URL): doctor exit 0, every setting reported 'set', zero markers in stdout+stderr outside the by-design 'coder model:' echo"

	# (3) The GitHub App credential group is reported from
	# dataDir/secrets/github-app.json rather than the environment, so the sweep
	# covers it in its own run: all five fields hold their own hostile marker
	# in a throwaway data dir. Every field must be reported as `set` and no
	# marker may print on either stream.
	local v1="$(sweep_marker 'GitHub_App_appId')" v2="$(sweep_marker 'GitHub_App_slug')" v3="$(sweep_marker 'GitHub_App_privateKey')" v4="$(sweep_marker 'GitHub_App_installationId')" v5="$(sweep_marker 'GitHub_App_org')"
	mkdir -p "$tmp/gh-data/secrets"
	APP_FILE="$tmp/gh-data/secrets/github-app.json" A1="$v1" A2="$v2" A3="$v3" A4="$v4" A5="$v5" node -e 'require("fs").writeFileSync(process.env.APP_FILE, JSON.stringify({appId:process.env.A1, slug:process.env.A2, privateKey:process.env.A3, installationId:process.env.A4, org:process.env.A5}));'
	DATA_DIR="$tmp/gh-data" env "${unset_args[@]}" npm run doctor >"$tmp/out-gh" 2>"$tmp/err-gh"
	status=$?
	[ "$status" -eq 0 ] || fail "sweep: doctor exited $status with a hostile dataDir/secrets/github-app.json"
	sweep_assert_absent "$tmp/err-gh" "$v1" 'GitHub_App_appId' || exit 1
	sweep_assert_absent "$tmp/out-gh" "$v1" 'GitHub_App_appId' || exit 1
	sweep_assert_absent "$tmp/err-gh" "$v2" 'GitHub_App_slug' || exit 1
	sweep_assert_absent "$tmp/out-gh" "$v2" 'GitHub_App_slug' || exit 1
	sweep_assert_absent "$tmp/err-gh" "$v3" 'GitHub_App_privateKey' || exit 1
	sweep_assert_absent "$tmp/out-gh" "$v3" 'GitHub_App_privateKey' || exit 1
	sweep_assert_absent "$tmp/err-gh" "$v4" 'GitHub_App_installationId' || exit 1
	sweep_assert_absent "$tmp/out-gh" "$v4" 'GitHub_App_installationId' || exit 1
	sweep_assert_absent "$tmp/err-gh" "$v5" 'GitHub_App_org' || exit 1
	sweep_assert_absent "$tmp/out-gh" "$v5" 'GitHub_App_org' || exit 1
	for line in 'GitHub App appId' 'GitHub App slug' 'GitHub App privateKey' 'GitHub App installationId' 'GitHub App org'; do
		grep -qxF "$line: set" "$tmp/out-gh" || fail "sweep: hostile GitHub App file does not produce exactly '$line: set'"
	done
	echo "ok GitHub App group: hostile marker in all five credential fields, all reported 'set', zero markers in stdout+stderr"

	echo "hostile sweep passed: ${#settings[@]} setting-scoped runs + 2 combined runs + GitHub App secrets group; every marker absent from stdout+stderr except the single by-design 'coder model:' echo of CODER_MODEL; the error path (hostile PUBLIC_URL → config throws) failed closed with no marker and no stack trace; POLARITY: exit 0 only when nothing leaked — a stray marker fails the sweep with LEAK and exit 1 (verified by --sweep --self-test)"
}

hostile_sweep_self_test() {
	local dir status
	dir="$(mktemp -d)" || fail "self-test: mktemp failed"
	trap 'rm -rf "$dir"' EXIT
	# A stray marker on an ordinary captured stdout line must fail the whole
	# sweep (exit 1) and the LEAK line must name the culprit's marker.
	status=0
	(SWEEP_INJECT=1 hostile_sweep) >"$dir/inject.log" 2>&1 || status=$?
	[ "$status" -eq 1 ] || fail "self-test: sweep exited $status (expected 1) with a hostile marker appended to captured stdout"
	grep -qF "LEAK: 'MARK_OPENROUTER_API_KEY_" "$dir/inject.log" ||
		fail "self-test: sweep failed for the wrong reason: $(head -5 "$dir/inject.log")"
	echo "sweep self-test ok: a stray marker on a captured stdout line makes the sweep exit 1, and the LEAK line names the culprit setting"
}

if [ "${1:-}" = "--sweep" ]; then
	if [ "${2:-}" = "--self-test" ]; then
		hostile_sweep_self_test
	else
		hostile_sweep
	fi
	exit $?
fi

if [ "${1:-}" = "--self-test" ]; then
	dir="$(mktemp -d)"
	trap 'rm -rf "$dir"' EXIT

	# a) The leak check must fire when the full value is printed.
	printf 'OPENROUTER_API_KEY: set\n%s\n' "$VALUE" >"$dir/full.txt"
	if leak_free "$dir/full.txt"; then
		fail "self-test: full value in captured output was NOT detected"
	fi
	echo "self-test ok: leak check detects the full value"

	# b) A short prefix appended to a captured output file must make the proof exit 1.
	status=0
	(PROOF_INJECT="sk-or"; run_proof) >"$dir/inject-sk-or.log" 2>&1 || status=$?
	[ "$status" -eq 1 ] ||
		fail "self-test: proof exited $status (expected 1) with 'sk-or' appended to captured output"
	grep -qF "LEAK: 'sk-or' found" "$dir/inject-sk-or.log" ||
		fail "self-test: proof failed for the wrong reason: $(cat "$dir/inject-sk-or.log")"
	echo "self-test ok: 'sk-or' appended to captured output makes the proof exit 1"

	# c) Same for the 3-character prefix 'sk-'.
	status=0
	(PROOF_INJECT="sk-"; run_proof) >"$dir/inject-sk-.log" 2>&1 || status=$?
	[ "$status" -eq 1 ] ||
		fail "self-test: proof exited $status (expected 1) with 'sk-' appended to captured output"
	grep -qF "LEAK: 'sk-' found" "$dir/inject-sk-.log" ||
		fail "self-test: proof failed for the wrong reason: $(cat "$dir/inject-sk-.log")"
	echo "self-test ok: 'sk-' appended to captured output makes the proof exit 1"

	# d) A doctor that exits non-zero must make the proof exit 1.
	status=0
	(run_proof false) >"$dir/failing-doctor.log" 2>&1 || status=$?
	[ "$status" -eq 1 ] ||
		fail "self-test: proof exited $status (expected 1) when the doctor exits non-zero"
	grep -qF "exited 1" "$dir/failing-doctor.log" ||
		fail "self-test: proof failed for the wrong reason: $(cat "$dir/failing-doctor.log")"
	echo "self-test ok: a non-zero doctor exit makes the proof exit 1"

	echo "self-tests passed: every negative case made the proof exit 1"
	exit 0
fi

run_proof
echo "no-leak proof passed: exit=0, key reported 'set', no prefix/substring of the value (checked from 3-char prefixes up, plus interior 8-char windows) in stdout or stderr, unset/empty report 'missing'"
