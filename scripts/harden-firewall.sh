#!/usr/bin/env bash
set -euo pipefail

APPLY="${APPLY:-0}"
RESET="${RESET:-0}"
SSH_PORT="${SSH_PORT:-22}"
ALLOW_PORTS="${ALLOW_PORTS:-22,3000,9000}"
DENY_PORTS="${DENY_PORTS:-5432,9001}"
APPLY_DOCKER_USER="${APPLY_DOCKER_USER:-1}"

if ! command -v ufw >/dev/null 2>&1; then
  echo "ufw not found; please install ufw first" >&2
  exit 1
fi

if [ "$EUID" -eq 0 ]; then
  UFW_CMD=(ufw)
  IPT4_CMD=(iptables)
  IPT6_CMD=(ip6tables)
else
  UFW_CMD=(sudo ufw)
  IPT4_CMD=(sudo iptables)
  IPT6_CMD=(sudo ip6tables)
fi

split_csv() {
  local input="$1"
  local old_ifs="$IFS"
  IFS=','
  read -r -a items <<< "$input"
  IFS="$old_ifs"
  local item=""
  for item in "${items[@]}"; do
    item="${item//[[:space:]]/}"
    if [ -n "$item" ]; then
      printf '%s\n' "$item"
    fi
  done
}

contains_port() {
  local target="$1"
  shift
  for item in "$@"; do
    if [ "$item" = "$target" ]; then
      return 0
    fi
  done
  return 1
}

mapfile -t allow_list < <(split_csv "$ALLOW_PORTS")
mapfile -t deny_list < <(split_csv "$DENY_PORTS")

if ! contains_port "$SSH_PORT" "${allow_list[@]}"; then
  echo "ALLOW_PORTS must include SSH_PORT ($SSH_PORT) to avoid lockout" >&2
  exit 1
fi

echo "FIREWALL_APPLY=$APPLY"
echo "FIREWALL_RESET=$RESET"
echo "FIREWALL_ALLOW_PORTS=${allow_list[*]}"
echo "FIREWALL_DENY_PORTS=${deny_list[*]}"
echo "FIREWALL_APPLY_DOCKER_USER=$APPLY_DOCKER_USER"

has_docker_user_chain4=0
if command -v iptables >/dev/null 2>&1 && "${IPT4_CMD[@]}" -S DOCKER-USER >/dev/null 2>&1; then
  has_docker_user_chain4=1
fi

has_docker_user_chain6=0
if command -v ip6tables >/dev/null 2>&1 && "${IPT6_CMD[@]}" -S DOCKER-USER >/dev/null 2>&1; then
  has_docker_user_chain6=1
fi

if [ "$APPLY" != "1" ]; then
  echo "dry run mode; set APPLY=1 to apply"
  echo "planned commands:"
  if [ "$RESET" = "1" ]; then
    echo "  ${UFW_CMD[*]} --force reset"
  fi
  echo "  ${UFW_CMD[*]} default deny incoming"
  echo "  ${UFW_CMD[*]} default allow outgoing"
  for port in "${allow_list[@]}"; do
    [ -n "$port" ] && echo "  ${UFW_CMD[*]} allow $port/tcp"
  done
  for port in "${deny_list[@]}"; do
    [ -n "$port" ] && echo "  ${UFW_CMD[*]} deny $port/tcp"
  done
  if [ "$APPLY_DOCKER_USER" = "1" ]; then
    if [ "$has_docker_user_chain4" = "1" ]; then
      for port in "${deny_list[@]}"; do
        [ -n "$port" ] && echo "  ${IPT4_CMD[*]} -I DOCKER-USER 1 -p tcp --dport $port -j DROP (if missing)"
      done
      echo "  ${IPT4_CMD[*]} -A DOCKER-USER -j RETURN (if missing)"
    else
      echo "  skip ipv4 DOCKER-USER (chain not found)"
    fi
    if [ "$has_docker_user_chain6" = "1" ]; then
      for port in "${deny_list[@]}"; do
        [ -n "$port" ] && echo "  ${IPT6_CMD[*]} -I DOCKER-USER 1 -p tcp --dport $port -j DROP (if missing)"
      done
      echo "  ${IPT6_CMD[*]} -A DOCKER-USER -j RETURN (if missing)"
    else
      echo "  skip ipv6 DOCKER-USER (chain not found)"
    fi
  fi
  echo "  ${UFW_CMD[*]} --force enable"
  echo "  ${UFW_CMD[*]} status numbered"
  exit 0
fi

if [ "$RESET" = "1" ]; then
  "${UFW_CMD[@]}" --force reset
fi

"${UFW_CMD[@]}" default deny incoming
"${UFW_CMD[@]}" default allow outgoing

for port in "${allow_list[@]}"; do
  [ -n "$port" ] && "${UFW_CMD[@]}" allow "$port/tcp"
done

for port in "${deny_list[@]}"; do
  [ -n "$port" ] && "${UFW_CMD[@]}" deny "$port/tcp"
done

if [ "$APPLY_DOCKER_USER" = "1" ]; then
  if [ "$has_docker_user_chain4" = "1" ]; then
    for port in "${deny_list[@]}"; do
      if [ -n "$port" ] && ! "${IPT4_CMD[@]}" -C DOCKER-USER -p tcp --dport "$port" -j DROP >/dev/null 2>&1; then
        "${IPT4_CMD[@]}" -I DOCKER-USER 1 -p tcp --dport "$port" -j DROP
      fi
    done
    if ! "${IPT4_CMD[@]}" -C DOCKER-USER -j RETURN >/dev/null 2>&1; then
      "${IPT4_CMD[@]}" -A DOCKER-USER -j RETURN
    fi
  fi

  if [ "$has_docker_user_chain6" = "1" ]; then
    for port in "${deny_list[@]}"; do
      if [ -n "$port" ] && ! "${IPT6_CMD[@]}" -C DOCKER-USER -p tcp --dport "$port" -j DROP >/dev/null 2>&1; then
        "${IPT6_CMD[@]}" -I DOCKER-USER 1 -p tcp --dport "$port" -j DROP
      fi
    done
    if ! "${IPT6_CMD[@]}" -C DOCKER-USER -j RETURN >/dev/null 2>&1; then
      "${IPT6_CMD[@]}" -A DOCKER-USER -j RETURN
    fi
  fi
fi

"${UFW_CMD[@]}" --force enable
"${UFW_CMD[@]}" status numbered
