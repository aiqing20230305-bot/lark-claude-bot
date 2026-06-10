import { useCurrentFrame, useVideoConfig, interpolate } from "remotion";

export const TitleCard = ({
  brand = "品牌名",
  tagline = "",
  bgColor = "#000000",
  textColor = "#ffffff",
  accentColor = "#ff6b35",
}) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();

  const fadeOpacity = interpolate(
    frame,
    [0, 20, durationInFrames - 20, durationInFrames],
    [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );
  const brandY = interpolate(frame, [0, 25], [40, 0], { extrapolateRight: "clamp" });
  const taglineOpacity = interpolate(frame, [20, 45], [0, 1], { extrapolateRight: "clamp" });

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        backgroundColor: bgColor,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "PingFang SC, Noto Sans CJK SC, sans-serif",
        opacity: fadeOpacity,
      }}
    >
      <div
        style={{
          width: 80,
          height: 4,
          backgroundColor: accentColor,
          marginBottom: 32,
          transform: `translateY(${brandY}px)`,
        }}
      />
      <div
        style={{
          color: textColor,
          fontSize: 96,
          fontWeight: "bold",
          textAlign: "center",
          padding: "0 60px",
          lineHeight: 1.2,
          transform: `translateY(${brandY}px)`,
        }}
      >
        {brand}
      </div>
      {tagline ? (
        <div
          style={{
            color: accentColor,
            fontSize: 40,
            marginTop: 28,
            textAlign: "center",
            padding: "0 80px",
            opacity: taglineOpacity,
            letterSpacing: 4,
          }}
        >
          {tagline}
        </div>
      ) : null}
    </div>
  );
};
