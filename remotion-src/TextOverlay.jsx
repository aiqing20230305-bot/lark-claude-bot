import { useCurrentFrame, useVideoConfig, interpolate } from "remotion";

export const TextOverlay = ({
  lines = [],
  position = "bottom",
  bgColor = "rgba(0,0,0,0.6)",
  textColor = "#ffffff",
  fontSize = 48,
  padding = 40,
}) => {
  const frame = useCurrentFrame();
  const { durationInFrames, width, height } = useVideoConfig();

  const slideY = interpolate(frame, [0, 20], [60, 0], { extrapolateRight: "clamp" });
  const opacity = interpolate(
    frame,
    [0, 15, durationInFrames - 15, durationInFrames],
    [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  const isBottom = position !== "top";

  return (
    <div
      style={{
        position: "absolute",
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: isBottom ? "flex-end" : "flex-start",
        pointerEvents: "none",
      }}
    >
      <div
        style={{
          backgroundColor: bgColor,
          padding: `${padding}px ${padding + 20}px`,
          opacity,
          transform: `translateY(${isBottom ? slideY : -slideY}px)`,
        }}
      >
        {lines.map((line, i) => (
          <div
            key={i}
            style={{
              color: textColor,
              fontSize: i === 0 ? fontSize : fontSize * 0.7,
              fontWeight: i === 0 ? "bold" : "normal",
              lineHeight: 1.5,
              fontFamily: "PingFang SC, Noto Sans CJK SC, sans-serif",
              marginBottom: i < lines.length - 1 ? 8 : 0,
            }}
          >
            {line}
          </div>
        ))}
      </div>
    </div>
  );
};
