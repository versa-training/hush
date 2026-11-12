# Sourced from the session environment script that hooks/session-start.js
# writes into CLAUDE_ENV_FILE, in the shell that runs each Bash and Monitor
# command, before the command. Sends that shell's stdout and stderr through
# filter.js and, when the shell exits, waits until the filter has written
# everything before the exit. Mode: "bash" when stdout is a regular file (the
# output file of a Bash call), else "monitor" (Monitor reads a socket). Returns
# 1 when the filter cannot start, so the caller withholds the output and exits
# 125. Needs bash 4.1 or newer: in any other shell it returns 0 without
# setting up the filter (session-start.js does not write the line for such a
# shell and tells the user so; this guard covers a line sourced anyway). The
# array test runs in a subshell: dash stops at an array expansion, also when
# BASH_VERSION is in its environment.
[ -n "${BASH_VERSION-}" ] && [ -n "${BASH_VERSINFO+x}" ] && ( eval ': "${BASH_VERSINFO[1]}"' ) 2>/dev/null \
  && eval '[ "${BASH_VERSINFO[0]}${BASH_VERSINFO[1]}" -ge 41 ]' 2>/dev/null || return 0
__hush_d=${BASH_SOURCE[0]%/*}
command -v node >/dev/null 2>&1 && [ -r "$__hush_d/filter.js" ] || return 1
if [ -n "${SRANDOM-}" ]; then
  printf -v __hush_n '%08x%08x' "$SRANDOM" "$SRANDOM"
else
  __hush_n=$(od -An -N8 -tx1 /dev/urandom 2>/dev/null) && __hush_n=${__hush_n//[!0-9a-f]/} && [ -n "$__hush_n" ] || return 1
fi
if [ -f /dev/stdout ]; then __hush_m=bash; else __hush_m=monitor; fi
exec {__hush_o}>&1
# The coproc starts the filter in the background and exits at once, so the
# filter is not a child of this shell and a bare `wait` in the command does
# not wait for it. The filter's first line on the ack pipe is its pid.
# Bash closes the coproc's own fds when it reaps the coproc, and marks them
# close-on-exec, so the shell works on copies. The coproc waits for one
# newline from the shell before it starts the filter, so it cannot be reaped
# before the copies exist; `read` takes one byte at a time from a pipe.
coproc __HUSH { read -r __hush_x || exit; { node "$__hush_d/filter.js" "$__hush_n" "$__hush_m" 3>&"$__hush_o" 2>/dev/null || { printf '%s\n' "[hush] output withheld: filter failed. Run node ${__hush_d%/*}/scripts/check.js to find the cause." >&"$__hush_o"; echo 1; }; } <&0 & echo "$!"; }
exec {__hush_a}<&"${__HUSH[0]}" {__hush_i}>&"${__HUSH[1]}" || return 1
printf '\n' >&"$__hush_i" || return 1
read -r -u "$__hush_a" __hush_p || return 1
wait "$__HUSH_PID" 2>/dev/null
# The header gives the filter the command text, for strict masking.
printf '\0HUSHCMD:%s\0%s\0' "$__hush_n" "${BASH_EXECUTION_STRING-}" >&"$__hush_i" || return 1
exec 1>&"$__hush_i" 2>&1 {__hush_i}>&- {__hush_o}>&-
unset __hush_i __hush_o __hush_m
__hush_on=$$
__hush_end() {
  local __hush_s=$? __hush_k=
  trap - EXIT
  if [ -e "/proc/$__hush_p/fd/0" ]; then
    { printf '\0HUSH:%s\0' "$__hush_n" >"/proc/$__hush_p/fd/0"; } 2>/dev/null || :
  else
    printf '\0HUSH:%s\0' "$__hush_n" 2>/dev/null || :
  fi
  exec 1>&- 2>&-
  read -r -u "$__hush_a" __hush_k || __hush_k=
  [ "$__hush_k" = 0 ] || exit 125
  exit "$__hush_s"
}
trap __hush_end EXIT
