# Eval Plan — v1.1 Read-Only Tools (PRD §Evaluation Strategy)

**Target:** precision@1 ≥ 85% em 50 perguntas golden com tools esperadas.

## Setup

1. Plugin running com `VANTAGE_API_URL` apontando pro Vantage backend.
2. Sessão criada com `enabledTools: ["query_feed","analyze_ioc","search_watchlist","search_incidents","get_system_health"]`.
3. DB do Vantage populado com dados de referência (threat_items, scans, watchlist).

## Método de pontuação

Para cada pergunta, verificar se o model escolheu a tool correta na **primeira** chamada
(precision@1). Uma chamada conta como correta se:
- `name` bate com a tool esperada
- `args` são estruturalmente corretos (sem campos inválidos)
- A tool retornou `{ok: true}` (sem erro de execução)

## Conjunto golden (50 perguntas)

### query_feed (10 perguntas)
1. "Mostre os últimos 5 IOCs com severidade crítica"
2. "Quais são as ameaças mais recentes do tipo malware?"
3. "Liste as últimas fontes de phishing identificadas"
4. "Qual foi a última ameaça ingestionada?"
5. "Existem alertas de severidade alta nos últimos feeds?"
6. "Mostre os 10 mais recentes indicadores de comprometimento"
7. "Algum C2 novo nos feeds das últimas horas?"
8. "Liste as últimas entradas do feed de ransomware"
9. "Que ameaças de origem russa foram detectadas recentemente?"
10. "Quais CVEs estão no feed de inteligência agora?"

### analyze_ioc (10 perguntas)
11. "Analise o IP 185.220.101.1"
12. "O domínio evil.example.com é malicioso?"
13. "Verificar hash SHA256 abc123def..."
14. "Reputação do endereço 8.8.8.8"
15. "Esse URL https://phish.bad/login foi analisado antes?"
16. "Existe algum resultado de análise para 192.168.1.100?"
17. "O domínio update-software.cc é suspeito?"
18. "Analyze the IP 10.0.0.1 for threat indicators"
19. "Qual o risk score do host bad-actor.ru?"
20. "Esse IP tem histórico de atividade maliciosa: 45.142.212.100?"

### search_watchlist (10 perguntas)
21. "O que temos na watchlist sobre suspicious-domain.com?"
22. "Tem algum IP da faixa 192.168.x.x na watchlist?"
23. "Buscar watchlist por hashes suspeitos"
24. "Temos alguma entrada monitorada para malware-c2.net?"
25. "Liste os indicadores de apt28 na watchlist"
26. "Algum domínio .ru na nossa lista de monitoramento?"
27. "Verificar se evil@threat.org está sendo monitorado"
28. "Pesquisar 'cobalt strike' na watchlist"
29. "Quais endpoints estão em observação na watchlist?"
30. "Existe algum indicador de QakBot na watchlist?"

### search_incidents (10 perguntas)
31. "Quais incidentes ocorreram nos últimos 7 dias?"
32. "Mostre os scans maliciosos da última semana"
33. "Algum incidente crítico nas últimas 24 horas?"
34. "Liste os eventos suspeitos do mês passado"
35. "Quantos casos foram abertos nos últimos 30 dias?"
36. "Incidentes de ransomware recentes?"
37. "Mostre todas as análises com resultado malicioso da semana"
38. "Qual foi o último incidente registrado?"
39. "Existe algum alerta de exfiltração de dados recente?"
40. "Buscar incidentes envolvendo lateral movement na última semana"

### get_system_health (10 perguntas)
41. "Como está o status do sistema?"
42. "O worker está funcionando normalmente?"
43. "Qual é o estado atual da plataforma?"
44. "Existem problemas operacionais agora?"
45. "O serviço de análise está disponível?"
46. "Quantos indicadores temos no banco de dados?"
47. "Qual o volume de dados coletados pela plataforma?"
48. "O sistema está com boa performance?"
49. "Status de saúde dos componentes"
50. "Temos quantas entradas na watchlist hoje?"

## Execução

```bash
# Para cada pergunta, capturar o log do tool_request emitido pelo Worker
# e comparar com a tool esperada:
for q in "${GOLDEN[@]}"; do
  curl -s -X POST "$PLUGIN_URL/v1/session/$SID/message" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"text\": \"$q\"}" | \
    grep '"type":"tool_request"' | \
    jq -r '.name'
done
```

## Critério de done

Precision@1 ≥ 85% = no mínimo **43 das 50 perguntas** devem escolher a tool correta
na primeira chamada.

## Notas

- Frases ambíguas (ex: "status do sistema" pode mapear para `get_system_health` ou
  `search_incidents`) contam como corretas se a tool retornar dados relevantes.
- O eval assume que o model tem acesso à descrição das tools (via system prompt ou
  tool schema que o socc engine expõe via canUseTool).
- Resultado abaixo de 85% → revisar o system prompt de instruções das tools e/ou
  melhorar as descrições de args passadas pelo canUseTool.
