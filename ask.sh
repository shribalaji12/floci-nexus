#!/bin/bash
# Interactive console for talking to FLOCI agents
# Usage: ./ask.sh [AGENT]   — defaults to ARIA

NEXUS="http://localhost:3002"
AGENT="${1:-ARIA}"
AGENT="${AGENT^^}"

CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
PURPLE='\033[0;35m'
GRAY='\033[0;90m'
RESET='\033[0m'
BOLD='\033[1m'

declare -A COLORS=(
  [ARIA]="$CYAN"
  [FORGE]="$YELLOW"
  [SAGE]="$GREEN"
  [SCOUT]="$PURPLE"
)
declare -A EMOJI=(
  [ARIA]="🎯"
  [FORGE]="⚙️ "
  [SAGE]="🔮"
  [SCOUT]="🔭"
)

# Check nexus is up
if ! curl -sf "$NEXUS/api/agents" > /dev/null 2>&1; then
  echo -e "${CYAN}floci-agents is not running on port 3002. Start it with:${RESET}"
  echo "  cd floci-agents && bash start.sh"
  exit 1
fi

COLOR="${COLORS[$AGENT]:-$CYAN}"
ICON="${EMOJI[$AGENT]:-🤖}"

echo -e "${BOLD}${COLOR}"
echo "╔══════════════════════════════════════════╗"
echo "║  FLOCI NEXUS — Agent Console             ║"
echo "╚══════════════════════════════════════════╝${RESET}"
echo -e "${COLOR}  Agent : ${ICON} ${AGENT}${RESET}"
echo -e "${GRAY}  Switch : type /agent FORGE  (or ARIA, SAGE, SCOUT)${RESET}"
echo -e "${GRAY}  Quit   : type /exit or Ctrl+C${RESET}"
echo ""

HISTORY="[]"

while true; do
  echo -ne "${BOLD}You › ${RESET}"
  read -r INPUT || break
  [[ -z "$INPUT" ]] && continue

  # Commands
  if [[ "$INPUT" == "/exit" || "$INPUT" == "/quit" ]]; then
    echo -e "${GRAY}Goodbye.${RESET}"
    break
  fi
  if [[ "$INPUT" =~ ^/agent[[:space:]]+([A-Za-z]+)$ ]]; then
    AGENT="${BASH_REMATCH[1]^^}"
    COLOR="${COLORS[$AGENT]:-$CYAN}"
    ICON="${EMOJI[$AGENT]:-🤖}"
    HISTORY="[]"
    echo -e "${COLOR}  Switched to ${ICON} ${AGENT}${RESET}\n"
    continue
  fi
  if [[ "$INPUT" == "/clear" ]]; then
    HISTORY="[]"
    echo -e "${GRAY}  Conversation cleared.${RESET}\n"
    continue
  fi
  if [[ "$INPUT" == "/help" ]]; then
    echo -e "${GRAY}  /agent ARIA|FORGE|SAGE|SCOUT  — switch agent"
    echo -e "  /clear                         — clear conversation history"
    echo -e "  /exit                          — quit${RESET}\n"
    continue
  fi

  # Escape question for JSON
  ESCAPED=$(printf '%s' "$INPUT" | python3 -c "import sys,json; print(json.dumps(sys.stdin.read()))")

  PAYLOAD=$(printf '{"agent":"%s","question":%s,"history":%s}' "$AGENT" "$ESCAPED" "$HISTORY")

  RESPONSE=$(curl -sf -X POST "$NEXUS/api/ask" \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD" 2>&1)

  if [[ $? -ne 0 ]]; then
    echo -e "${GRAY}  [error contacting nexus]${RESET}\n"
    continue
  fi

  ANSWER=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('answer',''))" 2>/dev/null)
  MODEL=$(echo "$RESPONSE"  | python3 -c "import sys,json; print(json.load(sys.stdin).get('model',''))"  2>/dev/null)

  echo ""
  echo -e "${COLOR}${ICON} ${AGENT}${GRAY} (${MODEL})${RESET}"
  echo -e "${COLOR}$(echo "$ANSWER" | fold -s -w 80)${RESET}"
  echo ""

  # Append to history for context
  USER_MSG=$(printf '%s' "$INPUT"  | python3 -c "import sys,json; print(json.dumps({'role':'user','content':sys.stdin.read()}))")
  ASST_MSG=$(printf '%s' "$ANSWER" | python3 -c "import sys,json; print(json.dumps({'role':'assistant','content':sys.stdin.read()}))")
  HISTORY=$(echo "$HISTORY" | python3 -c "
import sys,json
h=json.load(sys.stdin)
h.append($USER_MSG)
h.append($ASST_MSG)
print(json.dumps(h[-20:]))  # keep last 10 turns
")
done
