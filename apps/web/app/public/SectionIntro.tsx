export default function SectionIntro({ eyebrow, title, description }: { eyebrow: string; title: string; description: string }) {
  return <header className="public-section-intro"><span>{eyebrow}</span><h1>{title}</h1><p>{description}</p></header>;
}
