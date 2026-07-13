export function BrandWordmark() {
  return (
    <svg
      className="brand-wordmark brand-wordmark--custom-humanist"
      viewBox="0 0 360 60"
      role="img"
      aria-labelledby="peer-agent-wordmark-title"
      preserveAspectRatio="xMinYMid meet"
    >
      <title id="peer-agent-wordmark-title">Peer Agent</title>
      <text
        className="brand-wordmark-text"
        x="2"
        y="43"
        fontFamily="Avenir Next Rounded, Avenir Next, Nunito, sans-serif"
        fontSize="40"
        fontWeight="520"
        letterSpacing="-2"
      >
        Peer Agent
      </text>
      <path
        className="brand-wordmark-peer-arc"
        d="M66 33q9 7 18 0"
        fill="none"
        stroke="#d66f58"
        strokeWidth="1.8"
        strokeLinecap="round"
        aria-hidden="true"
      />
      <circle
        className="brand-wordmark-agent-dot"
        cx="181"
        cy="17"
        r="2.2"
        fill="#647fbd"
        aria-hidden="true"
      />
    </svg>
  );
}
