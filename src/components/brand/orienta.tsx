import Image from "next/image";
import { cn } from "@/lib/cn";
import logo from "@/assets/brand/orienta-logo.png";
import mark from "@/assets/brand/orienta-mark.png";

/*
 * Marca do Colégio Técnico Orienta. As imagens são creme sobre fundo
 * transparente (geradas a partir do logo.png original): use sempre sobre
 * fundo azul-marinho (`bg-brand-800` ou mais escuro).
 * `unoptimized`: PNGs pequenos e estáticos, sem depender do otimizador de
 * imagens no Worker da Cloudflare.
 */

/** Rosa dos ventos isolada (ícone da marca). O tamanho vem de `className` (ex.: `size-10`). */
export function OrientaMark({ className, decorative = true }: { className: string; decorative?: boolean }) {
  return <Image src={mark} alt={decorative ? "" : "Colégio Técnico Orienta"} unoptimized className={cn("select-none", className)} />;
}

/** Logo horizontal completo: rosa dos ventos + "Colégio Técnico Orienta". */
export function OrientaLogo({ className, priority }: { className?: string; priority?: boolean }) {
  return <Image src={logo} alt="Colégio Técnico Orienta" unoptimized priority={priority} className={cn("h-auto w-full select-none", className)} />;
}

/** Nome em texto, no estilo do logotipo, para tamanhos em que a imagem ficaria ilegível. */
export function OrientaWordmark({ className, tone = "light" }: { className?: string; tone?: "light" | "dark" }) {
  return (
    <span className={cn("block font-display leading-none", tone === "light" ? "text-gold-200" : "text-brand-800", className)}>
      <span className="block text-[0.5em] font-semibold tracking-[0.22em]">COLÉGIO TÉCNICO</span>
      <span className="mt-0.5 block font-bold tracking-[0.06em]">ORIENTA</span>
    </span>
  );
}
