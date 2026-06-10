import { Composition, AbsoluteFill, staticFile } from "remotion";
import { TitleCard } from "./TitleCard.jsx";
import { TextOverlay } from "./TextOverlay.jsx";

export const RemotionRoot = () => {
  return (
    <>
      <Composition
        id="TitleCard"
        component={TitleCard}
        durationInFrames={90}
        fps={30}
        width={1080}
        height={1920}
        defaultProps={{
          brand: "品牌名",
          tagline: "品牌标语",
          bgColor: "#000000",
          textColor: "#ffffff",
          accentColor: "#ff6b35",
        }}
      />
      <Composition
        id="TextOverlay"
        component={({ lines, position, bgColor, textColor, fontSize }) => (
          <AbsoluteFill style={{ backgroundColor: "transparent" }}>
            <TextOverlay
              lines={lines}
              position={position}
              bgColor={bgColor}
              textColor={textColor}
              fontSize={fontSize}
            />
          </AbsoluteFill>
        )}
        durationInFrames={90}
        fps={30}
        width={1080}
        height={1920}
        defaultProps={{
          lines: ["主标题文字", "副标题或说明文字"],
          position: "bottom",
          bgColor: "rgba(0,0,0,0.6)",
          textColor: "#ffffff",
          fontSize: 48,
        }}
      />
    </>
  );
};
