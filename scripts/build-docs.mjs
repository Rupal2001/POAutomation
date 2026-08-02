import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import JSZip from "jszip";

const root = path.resolve(import.meta.dirname, "..");
const docsDir = path.join(root, "docs");
const documents = [
  ["StyleFlow_Product_Overview_PRD.md", "StyleFlow_Product_Overview_PRD.docx"],
  ["StyleFlow_User_Guide.md", "StyleFlow_User_Guide.docx"],
  ["StyleFlow_Term_Glossary.md", "StyleFlow_Term_Glossary.docx"],
];

for (const [sourceName, outputName] of documents) {
  const source = path.join(docsDir, sourceName);
  const output = path.join(docsDir, outputName);
  const raw = path.join(docsDir, `.${outputName.replace(/\.docx$/, "")}.raw.docx`);
  const result = spawnSync("pandoc", [
    source,
    "--from=markdown+tex_math_dollars+raw_attribute-implicit_figures",
    `--resource-path=${docsDir}`,
    "--number-sections",
    "--standalone",
    `--output=${raw}`,
  ], { cwd: root, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`Pandoc failed for ${sourceName}:\n${result.stderr || result.stdout}`);
  }

  const zip = await JSZip.loadAsync(fs.readFileSync(raw));
  await applyStyleFlowBranding(zip);
  fs.writeFileSync(output, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 9 } }));
  fs.unlinkSync(raw);
  console.log(`Built ${path.relative(root, output)}`);
}

async function applyStyleFlowBranding(zip) {
  const stylesFile = zip.file("word/styles.xml");
  const documentFile = zip.file("word/document.xml");
  const settingsFile = zip.file("word/settings.xml");
  const themeFile = zip.file("word/theme/theme1.xml");
  if (!stylesFile || !documentFile || !settingsFile || !themeFile) throw new Error("Generated DOCX is missing required Word XML parts.");

  let styles = await stylesFile.async("string");
  styles = styles
    .replace(/w:val="0F4761"/g, 'w:val="80133D"')
    .replace(/w:val="365F91"/g, 'w:val="80133D"')
    .replace(/w:val="4F81BD"/g, 'w:val="C81D55"')
    .replace('<w:rFonts w:asciiTheme="minorHAnsi" w:cstheme="minorBidi" w:eastAsiaTheme="minorEastAsia" w:hAnsiTheme="minorHAnsi" />', '<w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial" />')
    .replace('<w:sz w:val="24" />\n        <w:szCs w:val="24" />', '<w:sz w:val="21" />\n        <w:szCs w:val="21" />')
    .replace('<w:spacing w:after="200" />', '<w:spacing w:after="140" w:line="276" w:lineRule="auto" />');

  styles = replaceStyle(styles, "Title", `
  <w:style w:styleId="Title" w:type="paragraph">
    <w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Subtitle"/><w:link w:val="TitleChar"/><w:uiPriority w:val="10"/><w:qFormat/>
    <w:pPr><w:keepNext/><w:spacing w:before="1900" w:after="180"/><w:jc w:val="center"/><w:pBdr><w:bottom w:val="single" w:sz="18" w:space="12" w:color="F23F6C"/></w:pBdr></w:pPr>
    <w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:b/><w:color w:val="3B1529"/><w:sz w:val="66"/><w:szCs w:val="66"/></w:rPr>
  </w:style>`);
  styles = replaceStyle(styles, "Subtitle", `
  <w:style w:styleId="Subtitle" w:type="paragraph">
    <w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/><w:next w:val="Author"/><w:link w:val="SubtitleChar"/><w:uiPriority w:val="11"/><w:qFormat/>
    <w:pPr><w:keepNext/><w:spacing w:before="120" w:after="520"/><w:jc w:val="center"/></w:pPr>
    <w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:color w:val="A50E45"/><w:sz w:val="30"/><w:szCs w:val="30"/></w:rPr>
  </w:style>`);
  styles = replaceStyle(styles, "Author", metadataStyle("Author", "Date", 20, "62545D"));
  styles = replaceStyle(styles, "Date", metadataStyle("Date", "BodyText", 19, "7A6C74"));
  styles = replaceStyle(styles, "Heading1", headingStyle("Heading1", "Heading1Char", 0, 36, "80133D", 420, 120, true));
  styles = replaceStyle(styles, "Heading2", headingStyle("Heading2", "Heading2Char", 1, 29, "C51D53", 300, 90, false));
  styles = replaceStyle(styles, "Heading3", headingStyle("Heading3", "Heading3Char", 2, 24, "5B293F", 220, 70, false));
  styles = replaceStyle(styles, "BlockText", `
  <w:style w:styleId="BlockText" w:type="paragraph">
    <w:name w:val="Block Text"/><w:basedOn w:val="BodyText"/><w:next w:val="BodyText"/><w:uiPriority w:val="9"/><w:unhideWhenUsed/><w:qFormat/>
    <w:pPr><w:spacing w:before="180" w:after="180"/><w:ind w:left="360" w:right="240"/><w:shd w:val="clear" w:color="auto" w:fill="FFF2F6"/><w:pBdr><w:left w:val="single" w:sz="22" w:space="10" w:color="F23F6C"/></w:pBdr></w:pPr>
    <w:rPr><w:color w:val="4D2839"/></w:rPr>
  </w:style>`);
  styles = replaceStyle(styles, "Table", `
  <w:style w:default="1" w:styleId="Table" w:type="table">
    <w:name w:val="Table"/><w:basedOn w:val="TableNormal"/><w:unhideWhenUsed/><w:qFormat/>
    <w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblBorders><w:top w:val="single" w:sz="4" w:color="E1D8DD"/><w:left w:val="single" w:sz="4" w:color="E1D8DD"/><w:bottom w:val="single" w:sz="4" w:color="E1D8DD"/><w:right w:val="single" w:sz="4" w:color="E1D8DD"/><w:insideH w:val="single" w:sz="3" w:color="EAE3E7"/><w:insideV w:val="single" w:sz="3" w:color="EAE3E7"/></w:tblBorders><w:tblCellMar><w:top w:w="90" w:type="dxa"/><w:left w:w="110" w:type="dxa"/><w:bottom w:w="90" w:type="dxa"/><w:right w:w="110" w:type="dxa"/></w:tblCellMar></w:tblPr>
    <w:tblStylePr w:type="firstRow"><w:rPr><w:b/><w:color w:val="FFFFFF"/></w:rPr><w:tcPr><w:shd w:val="clear" w:fill="80133D"/><w:vAlign w:val="center"/></w:tcPr></w:tblStylePr>
    <w:tblStylePr w:type="band1Horz"><w:tcPr><w:shd w:val="clear" w:fill="FCF7F9"/></w:tcPr></w:tblStylePr>
  </w:style>`);
  styles = replaceStyle(styles, "ImageCaption", `
  <w:style w:customStyle="1" w:styleId="ImageCaption" w:type="paragraph">
    <w:name w:val="Image Caption"/><w:basedOn w:val="Caption"/><w:pPr><w:jc w:val="center"/><w:spacing w:before="60" w:after="200"/></w:pPr><w:rPr><w:i/><w:color w:val="6F6269"/><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr>
  </w:style>`);
  zip.file("word/styles.xml", styles);

  let theme = await themeFile.async("string");
  theme = theme
    .replace('<a:srgbClr val="156082"/>', '<a:srgbClr val="80133D"/>')
    .replace('<a:srgbClr val="E97132"/>', '<a:srgbClr val="F23F6C"/>')
    .replace('<a:srgbClr val="196B24"/>', '<a:srgbClr val="07835D"/>')
    .replace('<a:srgbClr val="0F9ED5"/>', '<a:srgbClr val="F29C67"/>')
    .replace('<a:srgbClr val="467886"/>', '<a:srgbClr val="A50E45"/>');
  zip.file("word/theme/theme1.xml", theme);

  const pageBreak = '<w:p><w:pPr><w:pageBreakBefore/></w:pPr></w:p>';
  let document = await documentFile.async("string");
  document = document.replace(/(<w:p>[\s\S]*?<w:pStyle w:val="Date" \/>[\s\S]*?<\/w:p>)/, `$1${pageBreak}`);
  document = document.replace(/(<w:bookmarkStart\b[^>]*w:name="(?:document-purpose|about-this-guide)"[^>]*\/>)/, `${pageBreak}$1`);
  document = document.replace(/<wp:extent cx="5334000" cy="3704166" \/>/g, '<wp:extent cx="6200000" cy="4305556" />');
  document = document.replace(/<a:ext cx="5334000" cy="3704166" \/>/g, '<a:ext cx="6200000" cy="4305556" />');
  document = document.replace("<w:sectPr>", '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1008" w:right="1008" w:bottom="1008" w:left="1008" w:header="500" w:footer="500" w:gutter="0"/>');
  zip.file("word/document.xml", document);

  let settings = await settingsFile.async("string");
  settings = settings.replace("</w:settings>", '<w:updateFields w:val="true"/></w:settings>');
  zip.file("word/settings.xml", settings);
}

function replaceStyle(styles, styleId, replacement) {
  const pattern = new RegExp(`<w:style\\b(?=[^>]*w:styleId="${styleId}")[^>]*>[\\s\\S]*?<\\/w:style>`);
  if (!pattern.test(styles)) throw new Error(`DOCX style ${styleId} was not found.`);
  return styles.replace(pattern, replacement.trim());
}

function metadataStyle(id, next, size, color) {
  return `<w:style w:customStyle="1" w:styleId="${id}" w:type="paragraph"><w:name w:val="${id}"/><w:basedOn w:val="Normal"/><w:next w:val="${next}"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:after="80"/><w:jc w:val="center"/></w:pPr><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:color w:val="${color}"/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr></w:style>`;
}

function headingStyle(id, charStyle, level, size, color, before, after, border) {
  const tabPosition = level === 0 ? 720 : level === 1 ? 540 : 420;
  return `<w:style w:styleId="${id}" w:type="paragraph"><w:name w:val="heading ${level + 1}"/><w:basedOn w:val="Normal"/><w:next w:val="BodyText"/><w:link w:val="${charStyle}"/><w:uiPriority w:val="9"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:tabs><w:tab w:val="left" w:pos="${tabPosition}"/></w:tabs><w:spacing w:before="${before}" w:after="${after}"/><w:outlineLvl w:val="${level}"/>${border ? '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="5" w:color="EBC7D3"/></w:pBdr>' : ""}</w:pPr><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:b/><w:color w:val="${color}"/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr></w:style>`;
}
